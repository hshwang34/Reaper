// Viewer payments (Stripe Connect) against a fake Stripe: the fee split, the
// checkout guards, the webhook → hijack path, idempotency, and the rule that
// a viewer only pays for a hijack that actually happened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { upsertChannel } from "../src/auth.js";
import { getRuntime } from "../src/channels.js";
import { channels, db, payments, tokenMints } from "../src/db.js";
import { splitPayment } from "../src/fees.js";
import {
  dropQueuedPaid,
  sweepStalePaid,
  START_DEADLINE_MS,
  onboardingLink,
  createCheckout,
  handleWebhook,
  PaymentError,
  reconcileOnBoot,
  setStripeForTests,
  settleJob,
  type StripeLike,
} from "../src/payments.js";

// ── Fee math ──────────────────────────────────────────────────────────────

test("fees: $10 for 10s → 70¢ to us (20¢ GPU + 50¢ margin), ~59¢ to Stripe, $8.71 to the streamer", () => {
  const s = splitPayment(1000, 10);
  assert.deepEqual(
    [s.stripeFeeCents, s.gpuCents, s.marginCents, s.applicationFeeCents, s.streamerCents],
    [59, 20, 50, 70, 871],
  );
});

test("fees: GPU rounds up, and the fee never exceeds the payment", () => {
  assert.equal(splitPayment(300, 3, { platformFeePct: 0, gpuCostPerSec: 0.0101, stripePct: 0, stripeFixedCents: 0 }).gpuCents, 4);
  const tiny = splitPayment(50, 60);
  assert.equal(tiny.applicationFeeCents, 50);
  assert.equal(tiny.streamerCents, 0, "never negative");
});

// ── Fake Stripe ───────────────────────────────────────────────────────────

const calls = { sessions: 0, refunds: [] as { pi: string; fee: boolean; account: string; key: string }[] };
const fake: StripeLike = {
  accounts: { retrieve: async (id) => ({ id, charges_enabled: true }) },
  v2: {
    core: {
      accounts: {
        create: async (p, opts) => {
          // Express + Managed Risk is preview-only: the version must ride along.
          assert.equal(p.dashboard, "express");
          assert.equal(opts.apiVersion, "2026-09-30.preview");
          return { id: "acct_test" };
        },
      },
    },
  },
  accountLinks: { create: async () => ({ url: "https://connect.stripe.test/onboard" }) },
  checkout: {
    sessions: {
      create: async (p, opts) => {
        calls.sessions++;
        // Direct charge: created ON the streamer's account, fee to us.
        assert.equal(opts.stripeAccount, "acct_paid");
        assert.equal(p.payment_intent_data?.transfer_data, undefined);
        assert.ok(p.payment_intent_data?.application_fee_amount! > 0);
        return { id: `cs_test_${calls.sessions}`, url: `https://checkout.stripe.test/${calls.sessions}` };
      },
    },
  },
  refunds: {
    create: async (p, opts) => {
      calls.refunds.push({
        pi: String(p.payment_intent),
        fee: p.refund_application_fee === true,
        account: opts.stripeAccount,
        key: opts.idempotencyKey,
      });
      return { id: `re_${calls.refunds.length}` };
    },
  },
  webhooks: {
    // The "signature" check: the fake accepts any payload signed "ok".
    constructEvent: (payload, header) => {
      if (header !== "ok") throw new Error("bad signature");
      return JSON.parse(payload.toString()) as never;
    },
  },
};
setStripeForTests(fake);

function payableChannel(id: string, online = true) {
  upsertChannel(id, id.replace("dev:", ""), id);
  db.update(channels).set({ stripeAccountId: "acct_paid", payoutsEnabled: 1 }).where(eq(channels.id, id)).run();
  const rt = getRuntime(id)!;
  // The streamer's app is connected (the router reports a non-OFFLINE state).
  if (online) rt.engine.setRouterState("IDLE");
  return rt;
}

function paidEvent(
  eventId: string,
  sessionId: string,
  over: { account?: string; amount?: number; metadataPaymentId?: string; asSession?: string } = {},
) {
  const row = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  return Buffer.from(
    JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      account: over.account ?? "acct_paid", // Connect event: the streamer's account
      data: {
        object: {
          id: over.asSession ?? sessionId,
          payment_status: "paid",
          payment_intent: `pi_${sessionId}`,
          amount_total: over.amount ?? row.amountCents,
          currency: "usd",
          metadata: { paymentId: over.metadataPaymentId ?? row.id },
        },
      },
    }),
  );
}

const statusOf = (sessionId: string) =>
  db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!.status;

// ── Checkout guards ───────────────────────────────────────────────────────

test("checkout: refused until the streamer's payouts are verified", async () => {
  upsertChannel("dev:unverified", "unverified", "Unverified");
  const rt = getRuntime("dev:unverified")!;
  const sub = rt.correlation.add({ prompt: "x", presetId: "lava-room", tipperName: null, imageUrl: null });
  await assert.rejects(
    createCheckout("dev:unverified", { code: sub.code, amountUsd: 10, viewerName: "v", returnUrl: "https://x/c/u" }),
    (e) => e instanceof PaymentError && e.status === 409,
  );
  rt.stop();
});

test("checkout: minimum amount and unknown code are rejected", async () => {
  const rt = payableChannel("dev:guards");
  const sub = rt.correlation.add({ prompt: "x", presetId: "lava-room", tipperName: null, imageUrl: null });
  await assert.rejects(
    createCheckout("dev:guards", { code: sub.code, amountUsd: 1, viewerName: "v", returnUrl: "https://x/c/g" }),
    (e) => e instanceof PaymentError && e.status === 400,
  );
  await assert.rejects(
    createCheckout("dev:guards", { code: "ZZZZ", amountUsd: 10, viewerName: "v", returnUrl: "https://x/c/g" }),
    (e) => e instanceof PaymentError && e.status === 410,
  );
  rt.stop();
});

// ── Webhook → hijack → settlement ─────────────────────────────────────────

test("paid webhook runs the viewer's effect once; a replay is ignored; a bad signature is 400", async () => {
  const rt = payableChannel("dev:paid");
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  const url = await createCheckout("dev:paid", { code: sub.code, amountUsd: 10, viewerName: "alice", returnUrl: "https://x/c/paid" });
  assert.match(url, /^https:\/\/checkout\.stripe\.test\//);
  const sessionId = `cs_test_${calls.sessions}`;
  assert.equal(statusOf(sessionId), "pending");
  // The submission is held for the life of the Checkout session (30 min+).
  assert.ok(rt.correlation.get(sub.code)!.expiresAt > Date.now() + 25 * 60_000);

  assert.equal(await handleWebhook(paidEvent("evt_1", sessionId), "nope"), 400);
  assert.equal(await handleWebhook(paidEvent("evt_1", sessionId), "ok"), 200);
  assert.equal(statusOf(sessionId), "paid");
  assert.equal(rt.correlation.get(sub.code), undefined, "the paid code was consumed by the job");
  const queued = rt.engine.snapshot().queueLength;

  // Stripe redelivers the same event: no second hijack.
  assert.equal(await handleWebhook(paidEvent("evt_1", sessionId), "ok"), 200);
  assert.equal(rt.engine.snapshot().queueLength, queued);

  // The job never ran (the router never connected) and the runtime stops:
  // the viewer is refunded in full, on the streamer's account, fee returned.
  const before = calls.refunds.length;
  rt.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statusOf(sessionId), "refunded");
  const r = calls.refunds[before]!;
  assert.deepEqual([r.pi, r.fee, r.account], [`pi_${sessionId}`, true, "acct_paid"]);
  assert.match(r.key ?? "", /^refund-/, "idempotent at Stripe too");
});

test("a delivered hijack settles as delivered — no refund", async () => {
  const rt = payableChannel("dev:delivered");
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await createCheckout("dev:delivered", { code: sub.code, amountUsd: 5, viewerName: "bob", returnUrl: "https://x/c/d" });
  const sessionId = `cs_test_${calls.sessions}`;
  await handleWebhook(paidEvent("evt_2", sessionId), "ok");
  const p = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  const before = calls.refunds.length;
  settleJob(
    { jobId: "job-ok", tip: { source: "stripe", amount: 5, message: sub.code, username: "bob", ref: p.id } } as never,
    true,
    "completed",
  );
  assert.equal(statusOf(sessionId), "delivered");
  assert.equal(calls.refunds.length, before);
  rt.stop(); // a delivered payment is never refunded afterwards
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statusOf(sessionId), "delivered");
});

test("payment arriving after the effect expired is refunded — never a default preset", async () => {
  const rt = payableChannel("dev:expired");
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await createCheckout("dev:expired", { code: sub.code, amountUsd: 5, viewerName: "c", returnUrl: "https://x/c/e" });
  const sessionId = `cs_test_${calls.sessions}`;
  rt.correlation.match({ source: "fake", amount: 1, message: sub.code, username: "x" }); // consumed elsewhere
  const queued = rt.engine.snapshot().queueLength;
  await handleWebhook(paidEvent("evt_3", sessionId), "ok");
  assert.equal(statusOf(sessionId), "refunded");
  assert.equal(rt.engine.snapshot().queueLength, queued, "no job ran");
  rt.stop();
});

test("boot reconciliation refunds payments a restart orphaned", async () => {
  payableChannel("dev:orphan").stop(); // a paid payment's channel always has an account
  const now = Date.now();
  db.insert(payments)
    .values({
      id: "pay-orphan",
      channelId: "dev:orphan",
      checkoutSessionId: "cs_orphan",
      paymentIntentId: "pi_orphan",
      code: "ABCD",
      amountCents: 500,
      applicationFeeCents: 70,
      gpuCents: 10,
      durationSec: 5,
      viewerName: "d",
      status: "paid",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  assert.ok((await reconcileOnBoot()) >= 1);
  assert.equal(statusOf("cs_orphan"), "refunded");
});

test("a job that failed AFTER its token was minted is never auto-refunded on the router's word", async () => {
  const rt = payableChannel("dev:forged");
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await createCheckout("dev:forged", { code: sub.code, amountUsd: 10, viewerName: "e", returnUrl: "https://x/c/f" });
  const sessionId = `cs_test_${calls.sessions}`;
  await handleWebhook(paidEvent("evt_forged", sessionId), "ok");
  const p = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  // The server minted the job's Decart token → GPU time was spent.
  db.insert(tokenMints).values({ channelId: "dev:forged", jobId: "job-forged", durationSec: 10, cappedSec: 25, createdAt: Date.now() }).run();
  const before = calls.refunds.length;
  settleJob(
    { jobId: "job-forged", tip: { source: "stripe", amount: 10, message: sub.code, username: "e", ref: p.id } } as never,
    false,
    "router says it failed",
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statusOf(sessionId), "failed_after_start");
  assert.equal(calls.refunds.length, before, "no automatic refund");
  rt.stop();
});

test("a forged session can't pay for someone else's payment (wrong session, account or amount)", async () => {
  const rt = payableChannel("dev:forge");
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await createCheckout("dev:forge", { code: sub.code, amountUsd: 20, viewerName: "v", returnUrl: "https://x/c/forge" });
  const sessionId = `cs_test_${calls.sessions}`;
  const real = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  // The streamer's own cheap session, carrying our copied paymentId.
  await handleWebhook(paidEvent("evt_f1", sessionId, { asSession: "cs_streamer_own", metadataPaymentId: real.id, amount: 50 }), "ok");
  assert.equal(statusOf(sessionId), "pending", "metadata alone never marks a payment paid");
  await handleWebhook(paidEvent("evt_f2", sessionId, { account: "acct_someone_else" }), "ok");
  assert.equal(statusOf(sessionId), "pending", "event from another account");
  await handleWebhook(paidEvent("evt_f3", sessionId, { amount: 300 }), "ok");
  assert.equal(statusOf(sessionId), "pending", "amount must match what we priced");
  assert.ok(rt.correlation.get(sub.code), "the effect is still waiting for a real payment");
  await handleWebhook(paidEvent("evt_f4", sessionId), "ok");
  assert.equal(statusOf(sessionId), "paid");
  rt.stop();
});

test("onboarding creates ONE Express + Managed Risk account per channel, then reuses it", async () => {
  upsertChannel("dev:onboard", "onboard", "Onboard");
  const url = await onboardingLink("dev:onboard", "US", "/dashboard");
  assert.equal(url, "https://connect.stripe.test/onboard");
  const row = db.select().from(channels).where(eq(channels.id, "dev:onboard")).get()!;
  assert.equal(row.stripeAccountId, "acct_test");
  await onboardingLink("dev:onboard", "US", "/dashboard"); // resume: no second account
  await assert.rejects(onboardingLink("dev:onboard", "usa", "/dashboard"), (e) => e instanceof PaymentError && e.status === 400);
  getRuntime("dev:onboard")?.stop();
});

test("no payment is taken while the streamer's app is offline", async () => {
  const rt = payableChannel("dev:offline", false);
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  const before = calls.sessions;
  await assert.rejects(
    createCheckout("dev:offline", { code: sub.code, amountUsd: 10, viewerName: "v", returnUrl: "https://x/c/o" }),
    (e) => e instanceof PaymentError && e.status === 409,
  );
  assert.equal(calls.sessions, before, "no Stripe session created");
  rt.stop();
});

/** Pay for an effect on a channel whose router is up but BUSY, so the paid
 *  job waits in the queue (it can't dispatch while a job is active). */
async function queuedPaidJob(id: string) {
  const rt = payableChannel(id);
  rt.engine.setRouterState("LIVE"); // busy: queued jobs wait
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await createCheckout(id, { code: sub.code, amountUsd: 5, viewerName: "w", returnUrl: "https://x/c/q" });
  const sessionId = `cs_test_${calls.sessions}`;
  await handleWebhook(paidEvent(`evt_${id}`, sessionId), "ok");
  assert.equal(statusOf(sessionId), "paid");
  assert.equal(rt.engine.snapshot().queueLength, 1);
  return { rt, sessionId };
}

test("streamer's app gone: queued paid hijacks are dropped AND refunded, and can't run later", async () => {
  const { rt, sessionId } = await queuedPaidJob("dev:gone");
  assert.equal(dropQueuedPaid("dev:gone", "the streamer's app went offline"), 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statusOf(sessionId), "refunded");
  assert.equal(rt.engine.snapshot().queueLength, 0, "removed from the queue before refunding");
  rt.stop();
});

test("backstop: a paid hijack that hasn't started within 15 minutes is dropped and refunded", async () => {
  const { rt, sessionId } = await queuedPaidJob("dev:stale");
  assert.equal(await sweepStalePaid(Date.now()), 0, "not stale yet");
  assert.equal(statusOf(sessionId), "paid");
  assert.ok((await sweepStalePaid(Date.now() + START_DEADLINE_MS + 1000)) >= 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statusOf(sessionId), "refunded");
  assert.equal(rt.engine.snapshot().queueLength, 0);
  rt.stop();
});

test("no payment is taken while the streamer has paused (panic)", async () => {
  const rt = payableChannel("dev:paused");
  rt.engine.pause();
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await assert.rejects(
    createCheckout("dev:paused", { code: sub.code, amountUsd: 10, viewerName: "v", returnUrl: "https://x/c/p" }),
    (e) => e instanceof PaymentError && e.status === 409,
  );
  rt.stop();
});

test("the sweep never refunds a hijack that's playing (dispatched just before the deadline)", async () => {
  const rt = payableChannel("dev:playing"); // router IDLE → the paid job dispatches immediately
  const sub = rt.correlation.add({ prompt: "lava", presetId: "lava-room", tipperName: null, imageUrl: null });
  await createCheckout("dev:playing", { code: sub.code, amountUsd: 5, viewerName: "p", returnUrl: "https://x/c/pl" });
  const sessionId = `cs_test_${calls.sessions}`;
  await handleWebhook(paidEvent("evt_playing", sessionId), "ok");
  const row = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  assert.ok(row.jobId, "jobId is recorded at dispatch, not at settlement");
  assert.equal(rt.engine.snapshot().activeJob?.jobId, row.jobId);
  const before = calls.refunds.length;
  await sweepStalePaid(Date.now() + START_DEADLINE_MS + 60_000);
  assert.equal(statusOf(sessionId), "paid", "playing — not refunded");
  assert.equal(calls.refunds.length, before);
  // It finishes: delivered.
  settleJob({ jobId: row.jobId!, tip: { source: "stripe", amount: 5, message: sub.code, username: "p", ref: row.id } } as never, true, "done");
  assert.equal(statusOf(sessionId), "delivered");
  rt.stop();
});

test("races: a refund happens once, and a late 'delivered' can't overwrite it (or vice versa)", async () => {
  const { rt, sessionId } = await queuedPaidJob("dev:race");
  const row = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  const before = calls.refunds.length;
  const { refund } = await import("../src/payments.js");
  await Promise.all([refund(row.id, "a"), refund(row.id, "b")]);
  assert.equal(calls.refunds.length, before + 1, "one Stripe refund");
  assert.equal(statusOf(sessionId), "refunded");
  settleJob({ jobId: "late", tip: { source: "stripe", amount: 5, message: "x", username: "w", ref: row.id } } as never, true, "done");
  assert.equal(statusOf(sessionId), "refunded", "a late delivery doesn't rewrite history");
  rt.engine.dropQueued(() => true, "cleanup");
  rt.stop();
});
