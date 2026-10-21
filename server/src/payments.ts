// Viewer payments — Stripe Connect. The reason the hosted plane can hold the
// Decart key without spending our own money: every GPU second is bought by a
// viewer, and our application fee covers it (server/src/fees.ts).
//
// Why Stripe Connect and not "take a cut of the Streamlabs tip": Streamlabs
// pays the streamer directly — the server only HEARS about a tip and can
// never subtract anything from it. The payment has to be created by us.
//
// Model: DIRECT charges with Stripe "Managed Risk" on Express accounts. The viewer pays on the
// streamer's own Stripe account (the streamer is the seller of record and
// pays Stripe's fee); our application fee is split off automatically. Stripe
// screens fraud and absorbs unrecoverable losses (stolen-card chargebacks) —
// a new platform can't take that liability on without Stripe's review, and
// a one-person platform shouldn't. We never hold or move the money.
//
// The flow:
//   1. Streamer onboards (dashboard / setup wizard): an Accounts v2 account
//      with the Express Dashboard, Stripe as fees + losses collector,
//      Stripe-hosted onboarding. `payouts_enabled` mirrors the account's
//      `charges_enabled`; until then the portal can't take payments.
//   2. Viewer submits an effect (moderated, as before) → gets a code → POST
//      /checkout → Stripe Checkout created ON the streamer's account with our
//      application fee. The submission is held open for the session's life.
//   3. Webhook checkout.session.completed — a Connect event, since the
//      session lives on the streamer's account (signature-verified,
//      idempotent on the event id) → a TipEvent { source: "stripe", message: code, ref:
//      paymentId } into the SAME engine path as every other trigger.
//   4. The job's terminal outcome settles the payment, but the refund
//      decision rests on SERVER-SIDE evidence, never on the router's word
//      (the router runs on the streamer's machine; a "failed" report is
//      theirs to forge). The evidence is the mint ledger — only this server
//      can issue the job's Decart token:
//        · no token minted → nothing could have played → automatic full
//          refund (our fee returned too);
//        · token minted, router says failed → GPU was spent; status
//          `failed_after_start` for manual review, no automatic refund.
//      ok → delivered.
//   5. Boot: runtimes are in-memory, so any payment still `paid` (accepted,
//      not settled) belonged to a job the restart destroyed → refunded.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
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
    retrieve(id: string): Promise<{ id: string; charges_enabled?: boolean }>;
  };
  v2: {
    core: {
      accounts: {
        create(p: Stripe.V2.Core.AccountCreateParams, opts: { apiVersion: string }): Promise<{ id: string }>;
      };
    };
  };
  accountLinks: {
    create(p: Stripe.AccountLinkCreateParams): Promise<{ url: string }>;
  };
  checkout: {
    sessions: {
      create(
        p: Stripe.Checkout.SessionCreateParams,
        opts: { stripeAccount: string },
      ): Promise<{ id: string; url: string | null }>;
    };
  };
  refunds: {
    create(
      p: Stripe.RefundCreateParams,
      opts: { stripeAccount: string; idempotencyKey: string },
    ): Promise<{ id: string }>;
  };
  webhooks: {
    constructEvent(payload: Buffer | string, header: string, secret: string): Stripe.Event;
  };
}

let client: StripeLike | null = null;

/** The Stripe client, or null when payments aren't configured (dev). */
export function stripe(): StripeLike | null {
  if (!client && env.stripeSecretKey) {
    // STRIPE_API_BASE (dev/e2e only — the production boot gate refuses it)
    // routes every SDK call, v1 and v2, to a local fake.
    const base = env.stripeApiBase ? new URL(env.stripeApiBase) : null;
    client = new Stripe(
      env.stripeSecretKey,
      base
        ? { host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(":", "") as "http" | "https" }
        : undefined,
    ) as unknown as StripeLike;
  }
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

/** Express Dashboard + Managed Risk is a Stripe public preview: account
 *  creation (only) must name the preview API version. Everything else —
 *  onboarding links, status, checkout, refunds — uses the stable API. */
const EXPRESS_MANAGED_RISK_API = "2026-09-30.preview";

/** A Connect account the streamer sells through: Accounts v2 with the
 *  lightweight Express Dashboard (the short Stripe-hosted onboarding — the
 *  full Dashboard's setup asks for far more), card payments, and Stripe as
 *  both fees and losses collector ("Managed Risk"). Accounts v1 `type:
 *  express` is refused for new platforms unless the platform assumes loss
 *  liability, which we deliberately don't. */
function accountParams(channelId: string, login: string, country: string): Stripe.V2.Core.AccountCreateParams {
  return {
    display_name: `twitch.tv/${login}`,
    dashboard: "express",
    identity: { country: country.toLowerCase() },
    configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
    metadata: { channelId, login },
  } as Stripe.V2.Core.AccountCreateParams;
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
    accountId = (
      await s.v2.core.accounts.create(accountParams(channelId, row.login, country), {
        apiVersion: EXPRESS_MANAGED_RISK_API,
      })
    ).id;
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
  const enabled = acct.charges_enabled === true;
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

  // Only take money for a hijack that can actually play: the streamer's app
  // (the router) must be connected. Otherwise the job would sit in a queue
  // with nowhere to run until something refunds it.
  const snap = rt.engine.snapshot();
  if (snap.routerState === "OFFLINE") {
    throw new PaymentError(409, `${row.login} isn't live right now. Try again when they're streaming.`);
  }
  if (snap.paused) {
    throw new PaymentError(409, "the streamer has paused hijacks right now — try again in a bit");
  }

  const code = input.code.trim().toUpperCase();
  const sub = rt.correlation.get(code);
  if (!sub) throw new PaymentError(410, "That effect expired. Pick it again.");

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
            name: `${durationSec}s Stream Hijack on twitch.tv/${row.login}`,
            description: sub.presetId ? `Effect: ${sub.presetId}` : "Custom effect",
          },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: split.applicationFeeCents,
      metadata: { paymentId, channelId, code },
    },
    metadata: { paymentId, channelId, code },
    expires_at: Math.floor(expiresAt / 1000),
    success_url: `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}paid=${encodeURIComponent(code)}`,
    // Backing out of Stripe lands on ?cancelled=1 so the page can say nothing was
    // charged. NOT via returnUrl itself: that also feeds success_url (paid=…).
    cancel_url: `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}cancelled=1`,
  },
  // Direct charge: the session (and the payment) live on the streamer's account.
  { stripeAccount: row.stripeAccountId },
  );
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
    if (session.payment_status === "paid") await onPaid(session, event.account ?? null);
  } else if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const channelId = account.metadata?.channelId;
    if (channelId) {
      db.update(channels)
        .set({ payoutsEnabled: account.charges_enabled ? 1 : 0 })
        .where(eq(channels.id, channelId))
        .run();
    }
  }
  return 200;
}

/** Payment status is a state machine; every change is ONE conditional
 *  UPDATE, so concurrent paths (webhook, job end, offline drop, sweep, boot
 *  reconcile) can't both act on a payment or overwrite each other:
 *
 *    pending → paid → delivered
 *                   → failed_after_start        (manual review)
 *                   → refunding → refunded | refund_failed
 *
 *  Returns false when the payment wasn't in an allowed `from` state — the
 *  caller lost the race and must do nothing. */
function transition(
  paymentId: string,
  from: string[],
  to: string,
  extra: Partial<typeof payments.$inferInsert> = {},
): boolean {
  return (
    db
      .update(payments)
      .set({ status: to, updatedAt: Date.now(), ...extra })
      .where(and(eq(payments.id, paymentId), inArray(payments.status, from)))
      .run().changes === 1
  );
}

async function onPaid(session: Stripe.Checkout.Session, account: string | null): Promise<void> {
  // Never trust the session's metadata to say WHICH payment this is: with
  // direct charges the streamer has a full Stripe Dashboard on the account
  // the payment lives on, sees our metadata, and could create their own
  // cheap session carrying a copied paymentId. Look the payment up by the
  // session id WE created (unforgeable), then check the event came from
  // that channel's account and the money matches what we priced.
  const p = db.select().from(payments).where(eq(payments.checkoutSessionId, session.id)).get();
  if (!p) {
    warn("payments", `paid session ${session.id} is not one we created — ignoring`);
    return;
  }
  const row = channelRow(p.channelId);
  const mismatch =
    !row?.stripeAccountId || account !== row.stripeAccountId
      ? "event from the wrong Stripe account"
      : session.amount_total !== p.amountCents || session.currency !== "usd"
        ? `amount ${session.amount_total} ${session.currency} ≠ ${p.amountCents} usd`
        : null;
  if (mismatch) {
    warn("payments", `REJECTED paid session ${session.id}: ${mismatch}`);
    return;
  }
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  if (!transition(p.id, ["pending"], "paid", { paymentIntentId })) return;

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

/** Hooked to the runtime's onDispatch: the moment a paid job leaves the
 *  queue for the streamer's app, the payment knows its job. From here on
 *  the sweep treats it as started and leaves settlement to the job's end. */
export function recordDispatch(job: HijackJob): void {
  if (job.tip.source !== "stripe" || !job.tip.ref) return;
  db.update(payments)
    .set({ jobId: job.jobId, updatedAt: Date.now() })
    .where(and(eq(payments.id, job.tip.ref), eq(payments.status, "paid")))
    .run();
}

/** Hooked to the runtime's onJobEnded: every accepted job ends exactly once. */
export function settleJob(job: HijackJob, ok: boolean, reason: string): void {
  const paymentId = job.tip.source === "stripe" ? job.tip.ref : undefined;
  if (!paymentId) return;
  if (ok) {
    if (!transition(paymentId, ["paid"], "delivered", { jobId: job.jobId, reason: null })) {
      warn("payments", `payment ${paymentId.slice(0, 8)}: delivered but already settled — left as is`);
    }
    return;
  }
  if (jobWasMinted(job.jobId)) {
    // GPU time was spent on this job; whether the viewer saw it is only the
    // router's claim. Don't let a forged "failed" report refund it — park it
    // for a human (refundable from the Stripe dashboard if genuine).
    if (transition(paymentId, ["paid"], "failed_after_start", { jobId: job.jobId, reason })) {
      warn("payments", `payment ${paymentId.slice(0, 8)}: job failed after its token was minted (${reason}) — manual review`);
    }
    return;
  }
  void refund(paymentId, reason);
}

/** Full refund of a direct charge, with our application fee returned, so the
 *  viewer gets everything back. (Stripe's processing fee on the original
 *  charge isn't returned — it lands on the streamer's account, the cost of
 *  a hijack their setup couldn't start.) */
export async function refund(paymentId: string, reason: string): Promise<void> {
  // Claim it atomically: only a `paid` payment can start refunding, and only
  // once — whoever loses the race (a second path, or a delivery that got
  // there first) does nothing.
  if (!transition(paymentId, ["paid"], "refunding", { reason })) return;
  const p = db.select().from(payments).where(eq(payments.id, paymentId)).get()!;
  const s = stripe();
  const row = channelRow(p.channelId);
  if (!s || !p.paymentIntentId || !row?.stripeAccountId) {
    transition(p.id, ["refunding"], "refund_failed", { reason: `${reason} (no payment intent / account)` });
    warn("payments", `REFUND FAILED ${p.id}: missing payment intent or account — needs manual action`);
    return;
  }
  try {
    await s.refunds.create(
      {
        payment_intent: p.paymentIntentId,
        // Our application fee goes back too, so the viewer is made whole and
        // the streamer isn't charged our fee for a hijack that never ran.
        refund_application_fee: true,
        metadata: { paymentId: p.id, reason: reason.slice(0, 200) },
      },
      // On the streamer's account (direct charge); idempotent at Stripe too,
      // so a retry after a crash mid-refund can't refund twice.
      { stripeAccount: row.stripeAccountId, idempotencyKey: `refund-${p.id}` },
    );
    transition(p.id, ["refunding"], "refunded");
    log("payments", `refunded ${p.id.slice(0, 8)} ($${(p.amountCents / 100).toFixed(2)}): ${reason}`);
  } catch (e) {
    transition(p.id, ["refunding"], "refund_failed", { reason: `${reason} — ${(e as Error).message}` });
    warn("payments", `REFUND FAILED ${p.id}: ${(e as Error).message} — needs manual action`);
  }
}

// ── 5. Paid hijacks that never start ──────────────────────────────────────
// The checkout gate only proves the streamer's app was up when the viewer
// PAID. Afterwards the app can drop off (crash, sleep, stream ended) or the
// streamer can panic-pause, leaving a paid job in a queue with nowhere to
// run. Two layers make sure the viewer gets their money back:
//   · app offline for OFFLINE_GRACE_MS → drop the channel's queued paid jobs
//     (channels.ts arms the timer from router-state reports);
//   · any paid job not started within START_DEADLINE_MS, whatever the cause
//     (paused, stuck) → dropped and refunded by the sweep below.
// Dropping goes through Engine.dropQueued, which ends the job as failed —
// settleJob then refunds it (no token was minted) — and removes it from the
// queue first, so a refunded hijack can never play afterwards.

export const OFFLINE_GRACE_MS = env.offlineGraceMs;
export const START_DEADLINE_MS = 15 * 60_000;

const isPaid = (job: HijackJob) => job.tip.source === "stripe";

/** Drop every queued paid job on a channel (its app is gone). */
export function dropQueuedPaid(channelId: string, reason: string): number {
  const rt = getRuntime(channelId);
  return rt ? rt.engine.dropQueued(isPaid, reason) : 0;
}

/** Refund paid hijacks that haven't started within the deadline. */
export async function sweepStalePaid(now = Date.now()): Promise<number> {
  const stale = db
    .select()
    .from(payments)
    .where(and(eq(payments.status, "paid"), sql`${payments.updatedAt} < ${now - START_DEADLINE_MS}`))
    .all();
  let n = 0;
  for (const p of stale) {
    const reason = "the hijack didn't start within 15 minutes";
    const rt = getRuntime(p.channelId);
    // Dispatched (jobId is recorded at dispatch): it has started — the job
    // settles through its own end (and the engine's deadline backstop), so
    // the sweep must never refund it, even if it's playing right now.
    if (p.jobId) continue;
    // Still queued: drop it — that ends it as failed and settleJob refunds.
    const dropped = rt ? rt.engine.dropQueued((j) => j.tip.ref === p.id, reason) : 0;
    // Neither queued nor dispatched (the job was lost): refund directly.
    if (dropped === 0) await refund(p.id, reason);
    n++;
  }
  if (n) warn("payments", `refunded ${n} paid hijack(s) that never started`);
  return n;
}

// ── 6. Boot reconciliation ────────────────────────────────────────────────

/** Runtimes (queue, active job) are process memory. A payment still `paid`
 *  at boot was accepted by an engine that no longer exists — its hijack will
 *  never run. Refund it. */
export async function reconcileOnBoot(): Promise<number> {
  // A crash between claiming a refund and Stripe confirming it leaves
  // `refunding`; put it back to `paid` so it's retried (the Stripe
  // idempotency key makes the retry safe).
  db.update(payments).set({ status: "paid" }).where(eq(payments.status, "refunding")).run();
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
