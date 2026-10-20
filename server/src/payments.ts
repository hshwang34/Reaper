// Viewer payments — Stripe Connect. The reason the hosted plane can hold the
// Decart key without spending our own money: every GPU second is bought by a
// viewer, through us, and we keep a fee that covers it (server/src/fees.ts).
//
// Why Stripe Connect and not "take a cut of the Streamlabs tip": Streamlabs
// pays the streamer directly — the server only HEARS about a tip and can
// never subtract anything from it. To fund the GPU, the money has to pass
// through an account we control. Connect makes that legal and boring: Stripe
// holds the funds, transfers the streamer's share to their own Express
// account, keeps our application fee, and pays everyone out. We never hold
// or transmit money ourselves.
//
// The flow:
//   1. Streamer onboards (dashboard / setup wizard): an Express account,
//      Stripe-hosted KYC. `payouts_enabled` mirrors the account's `transfers`
//      capability; until it's active the portal can't take payments.
//   2. Viewer submits an effect (moderated, as before) → gets a code → POST
//      /checkout → Stripe Checkout (a destination charge: amount to the
//      streamer, application fee to us). The submission is held open for the
//      life of the Checkout session.
//   3. Webhook checkout.session.completed (signature-verified, idempotent on
//      the event id) → a TipEvent { source: "stripe", message: code, ref:
//      paymentId } into the SAME engine path as every other trigger.
//   4. The job's terminal outcome settles the payment, but the refund
//      decision rests on SERVER-SIDE evidence, never on the router's word
//      (the router runs on the streamer's machine; a "failed" report is
//      theirs to forge). The evidence is the mint ledger — only this server
//      can issue the job's Decart token:
//        · no token minted → nothing could have played → automatic full
//          refund (transfer reversed, fee returned);
//        · token minted, router says failed → GPU was spent; status
//          `failed_after_start` for manual review, no automatic refund.
//      ok → delivered.
//   5. Boot: runtimes are in-memory, so any payment still `paid` (accepted,
//      not settled) belonged to a job the restart destroyed → refunded.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { computeDurationSec, type HijackJob } from "@rh/shared";
import { log, warn } from "@rh/core";
import { channels, db, payments, stripeEvents, tokenMints } from "./db.js";
import { env } from "./env.js";
import { splitPayment, type FeeConfig } from "./fees.js";
import { getRuntime } from "./channels.js";

/** The slice of the Stripe SDK we use — narrow enough to fake in tests. */
export interface StripeLike {
  accounts: {
    create(p: Stripe.AccountCreateParams): Promise<{ id: string }>;
    retrieve(id: string): Promise<{ id: string; capabilities?: { transfers?: string } | null }>;
  };
  accountLinks: {
    create(p: Stripe.AccountLinkCreateParams): Promise<{ url: string }>;
  };
  checkout: {
    sessions: {
      create(p: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }>;
    };
  };
  refunds: {
    create(p: Stripe.RefundCreateParams, opts?: { idempotencyKey?: string }): Promise<{ id: string }>;
  };
  webhooks: {
    constructEvent(payload: Buffer | string, header: string, secret: string): Stripe.Event;
  };
}

let client: StripeLike | null = null;

/** The Stripe client, or null when payments aren't configured (dev). */
export function stripe(): StripeLike | null {
  if (!client && env.stripeSecretKey) client = new Stripe(env.stripeSecretKey) as unknown as StripeLike;
  return client;
}

/** Tests inject a fake; production never calls this. */
export function setStripeForTests(fake: StripeLike | null): void {
  client = fake;
}

export const paymentsEnabled = () => Boolean(stripe());

const fees = (): FeeConfig => ({
  platformFeePct: env.platformFeePct,
  gpuCostPerSec: env.gpuCostPerSec,
  stripePct: 2.9,
  stripeFixedCents: 30,
});

/** Checkout sessions live 30 min (Stripe's minimum); the submission is held
 *  a little longer so a late completion can still claim it. */
const CHECKOUT_TTL_MS = 30 * 60_000;
const HOLD_GRACE_MS = 5 * 60_000;

export class PaymentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function channelRow(channelId: string) {
  return db.select().from(channels).where(eq(channels.id, channelId)).get();
}

// ── 1. Streamer onboarding ────────────────────────────────────────────────

/** Countries where Stripe can pay out a Connect Express account. A US
 *  platform pays non-US streamers through Stripe's cross-border payouts,
 *  which use the "recipient" service agreement (transfers only — the
 *  streamer's account receives our transfer; it never charges cards). */
function accountParams(channelId: string, login: string, country: string): Stripe.AccountCreateParams {
  const crossBorder = country !== "US";
  return {
    type: "express",
    country,
    capabilities: { transfers: { requested: true } },
    ...(crossBorder ? { tos_acceptance: { service_agreement: "recipient" } } : {}),
    business_profile: { product_description: `Reality Hijack payouts for twitch.tv/${login}` },
    metadata: { channelId, login },
  };
}

/** Start or resume Stripe onboarding; returns the Stripe-hosted URL. */
export async function onboardingLink(channelId: string, country: string, returnTo: string): Promise<string> {
  const s = stripe();
  if (!s) throw new PaymentError(503, "payments aren't configured on this server");
  const row = channelRow(channelId);
  if (!row) throw new PaymentError(404, "unknown channel");
  if (!/^[A-Z]{2}$/.test(country)) throw new PaymentError(400, "country must be a 2-letter code");

  let accountId = row.stripeAccountId;
  if (!accountId) {
    accountId = (await s.accounts.create(accountParams(channelId, row.login, country))).id;
    db.update(channels).set({ stripeAccountId: accountId }).where(eq(channels.id, channelId)).run();
    log("payments", `created Connect account ${accountId} for ${row.login} (${country})`);
  }
  const back = `${env.publicUrl}/api/c/${encodeURIComponent(channelId)}/payouts/return?to=${encodeURIComponent(returnTo)}`;
  const link = await s.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: back, // link expired/reused → our return route re-checks and the UI offers a new link
    return_url: back,
  });
  return link.url;
}

/** Pull the account's capability from Stripe (on return from onboarding,
 *  and on every account.updated webhook). */
export async function refreshPayouts(channelId: string): Promise<boolean> {
  const s = stripe();
  const row = channelRow(channelId);
  if (!s || !row?.stripeAccountId) return false;
  const acct = await s.accounts.retrieve(row.stripeAccountId);
  const enabled = acct.capabilities?.transfers === "active";
  db.update(channels)
    .set({ payoutsEnabled: enabled ? 1 : 0 })
    .where(eq(channels.id, channelId))
    .run();
  return enabled;
}

export function payoutStatus(channelId: string): { configured: boolean; started: boolean; enabled: boolean } {
  const row = channelRow(channelId);
  return {
    configured: paymentsEnabled(),
    started: Boolean(row?.stripeAccountId),
    enabled: Boolean(row?.payoutsEnabled),
  };
}

// ── 2. Viewer checkout ────────────────────────────────────────────────────

export interface CheckoutInput {
  code: string;
  amountUsd: number;
  viewerName: string;
  /** Where Stripe sends the viewer back (the portal page). */
  returnUrl: string;
}

/** The effective minimum for a channel: ours or theirs, whichever is higher. */
export function minPaymentUsd(channelId: string): number {
  const rt = getRuntime(channelId);
  return Math.max(env.minPaymentUsd, rt?.getSettings().minTipUSD ?? 0);
}

export async function createCheckout(channelId: string, input: CheckoutInput): Promise<string> {
  const s = stripe();
  if (!s) throw new PaymentError(503, "payments aren't configured on this server");
  const row = channelRow(channelId);
  const rt = getRuntime(channelId);
  if (!row || !rt) throw new PaymentError(404, "unknown channel");
  if (!row.payoutsEnabled || !row.stripeAccountId) {
    throw new PaymentError(409, "this streamer hasn't finished setting up payments yet");
  }

  const code = input.code.trim().toUpperCase();
  const sub = rt.correlation.get(code);
  if (!sub) throw new PaymentError(410, "that effect expired — submit it again");

  const settings = rt.getSettings();
  const min = minPaymentUsd(channelId);
  // Whole cents only; no tiny or absurd charges.
  const amountCents = Math.round(input.amountUsd * 100);
  if (!Number.isFinite(amountCents) || amountCents < Math.round(min * 100)) {
    throw new PaymentError(400, `minimum is $${min.toFixed(2)}`);
  }
  if (amountCents > 50_000) throw new PaymentError(400, "maximum is $500");
  const amountUsd = amountCents / 100;
  const durationSec = computeDurationSec(amountUsd, settings);
  const split = splitPayment(amountCents, durationSec, fees());
  const viewerName = input.viewerName.trim().slice(0, 40) || "viewer";

  const expiresAt = Date.now() + CHECKOUT_TTL_MS;
  const paymentId = randomUUID();
  const session = await s.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: `${durationSec}s Reality Hijack on twitch.tv/${row.login}`,
            description: sub.presetId ? `Effect: ${sub.presetId}` : "Custom effect",
          },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: split.applicationFeeCents,
      transfer_data: { destination: row.stripeAccountId },
      metadata: { paymentId, channelId, code },
    },
    metadata: { paymentId, channelId, code },
    expires_at: Math.floor(expiresAt / 1000),
    success_url: `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}paid=${encodeURIComponent(code)}`,
    cancel_url: input.returnUrl,
  });
  if (!session.url) throw new PaymentError(502, "Stripe returned no checkout URL");

  rt.correlation.hold(code, expiresAt + HOLD_GRACE_MS);
  const now = Date.now();
  db.insert(payments)
    .values({
      id: paymentId,
      channelId,
      checkoutSessionId: session.id,
      code,
      amountCents,
      applicationFeeCents: split.applicationFeeCents,
      gpuCents: split.gpuCents,
      durationSec,
      viewerName,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  log("payments", `checkout ${session.id} — $${amountUsd.toFixed(2)} → ${row.login} (fee ${split.applicationFeeCents}¢)`);
  return session.url;
}

// ── 3. Webhook ────────────────────────────────────────────────────────────

/** Verify, dedupe and handle one Stripe webhook. Returns the HTTP status. */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<number> {
  const s = stripe();
  if (!s || !env.stripeWebhookSecret) return 503;
  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
  } catch (e) {
    warn("payments", `webhook signature rejected: ${(e as Error).message}`);
    return 400;
  }
  // At-least-once delivery: the event id is the idempotency key. Recorded
  // BEFORE handling, so a crash mid-handle leans toward "not run twice"
  // (a lost paid event is reconciled into a refund; a doubled one would run
  // a second, unpaid hijack).
  const fresh = db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type, receivedAt: Date.now() })
    .onConflictDoNothing()
    .run();
  if (fresh.changes === 0) return 200;

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "paid") await onPaid(session);
  } else if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const channelId = account.metadata?.channelId;
    if (channelId) {
      db.update(channels)
        .set({ payoutsEnabled: account.capabilities?.transfers === "active" ? 1 : 0 })
        .where(eq(channels.id, channelId))
        .run();
    }
  }
  return 200;
}

function setStatus(paymentId: string, status: string, extra: Partial<typeof payments.$inferInsert> = {}) {
  db.update(payments)
    .set({ status, updatedAt: Date.now(), ...extra })
    .where(eq(payments.id, paymentId))
    .run();
}

async function onPaid(session: Stripe.Checkout.Session): Promise<void> {
  const paymentId = session.metadata?.paymentId;
  const p = paymentId ? db.select().from(payments).where(eq(payments.id, paymentId)).get() : undefined;
  if (!p) {
    warn("payments", `paid session ${session.id} has no payment row — ignoring`);
    return;
  }
  if (p.status !== "pending") return;
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  setStatus(p.id, "paid", { paymentIntentId });

  const rt = getRuntime(p.channelId);
  // The viewer paid for THEIR effect. If the submission is gone (expired, or
  // the channel was suspended), never fall back to a default preset — refund.
  if (!rt || !rt.correlation.get(p.code)) {
    await refund(p.id, "the effect expired before the payment arrived");
    return;
  }
  const outcome = rt.onTip({
    source: "stripe",
    amount: p.amountCents / 100,
    message: p.code, // exact code match — the engine's first-priority path
    username: p.viewerName,
    ref: p.id,
  });
  log("payments", `paid ${p.id.slice(0, 8)} → ${outcome}`);
  // "ignored: …" means the engine never accepted a job (e.g. the streamer
  // raised their minimum between checkout and payment). No job will ever end,
  // so settle now.
  if (outcome.startsWith("ignored")) await refund(p.id, outcome);
}

// ── 4. Settlement ─────────────────────────────────────────────────────────

/** Was a Decart token ever minted for this job? Server-side truth: the
 *  router (streamer's machine) can claim anything, but only this server can
 *  issue the token the hijack needs to run at all. */
function jobWasMinted(jobId: string): boolean {
  return Boolean(db.select({ id: tokenMints.id }).from(tokenMints).where(eq(tokenMints.jobId, jobId)).get());
}

/** Hooked to the runtime's onJobEnded: every accepted job ends exactly once. */
export function settleJob(job: HijackJob, ok: boolean, reason: string): void {
  const paymentId = job.tip.source === "stripe" ? job.tip.ref : undefined;
  if (!paymentId) return;
  if (ok) {
    setStatus(paymentId, "delivered", { jobId: job.jobId, reason: null });
    return;
  }
  db.update(payments).set({ jobId: job.jobId }).where(eq(payments.id, paymentId)).run();
  if (jobWasMinted(job.jobId)) {
    // GPU time was spent on this job; whether the viewer saw it is only the
    // router's claim. Don't let a forged "failed" report refund it — park it
    // for a human (refundable from the Stripe dashboard if genuine).
    setStatus(paymentId, "failed_after_start", { reason });
    warn("payments", `payment ${paymentId.slice(0, 8)}: job failed after its token was minted (${reason}) — manual review`);
    return;
  }
  void refund(paymentId, reason);
}

/** Full refund of a destination charge: the transfer to the streamer is
 *  reversed and our application fee returned, so the viewer gets everything
 *  back. (Stripe keeps its own processing fee — the cost of a failed
 *  hijack, ~59¢ on $10, is ours.) */
export async function refund(paymentId: string, reason: string): Promise<void> {
  const p = db.select().from(payments).where(eq(payments.id, paymentId)).get();
  if (!p || p.status === "refunded" || p.status === "delivered") return;
  const s = stripe();
  if (!s || !p.paymentIntentId) {
    setStatus(p.id, "refund_failed", { reason: `${reason} (no payment intent)` });
    return;
  }
  try {
    await s.refunds.create(
      {
        payment_intent: p.paymentIntentId,
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: { paymentId: p.id, reason: reason.slice(0, 200) },
      },
      // Stripe-side idempotency too: a retried refund can't refund twice.
      { idempotencyKey: `refund-${p.id}` },
    );
    setStatus(p.id, "refunded", { reason });
    log("payments", `refunded ${p.id.slice(0, 8)} ($${(p.amountCents / 100).toFixed(2)}): ${reason}`);
  } catch (e) {
    setStatus(p.id, "refund_failed", { reason: `${reason} — ${(e as Error).message}` });
    warn("payments", `REFUND FAILED ${p.id}: ${(e as Error).message} — needs manual action`);
  }
}

// ── 5. Boot reconciliation ────────────────────────────────────────────────

/** Runtimes (queue, active job) are process memory. A payment still `paid`
 *  at boot was accepted by an engine that no longer exists — its hijack will
 *  never run. Refund it. */
export async function reconcileOnBoot(): Promise<number> {
  const orphans = db.select().from(payments).where(eq(payments.status, "paid")).all();
  for (const p of orphans) await refund(p.id, "server restarted before the hijack ran");
  if (orphans.length) warn("payments", `refunded ${orphans.length} payment(s) orphaned by a restart`);
  return orphans.length;
}

/** Dashboard summary for a channel. */
export function earnings(channelId: string) {
  const rows = db
    .select({
      status: payments.status,
      n: sql<number>`count(*)`,
      gross: sql<number>`coalesce(sum(amount_cents), 0)`,
      fees: sql<number>`coalesce(sum(application_fee_cents), 0)`,
    })
    .from(payments)
    .where(and(eq(payments.channelId, channelId), sql`${payments.status} != 'pending'`))
    .groupBy(payments.status)
    .all();
  return rows;
}
