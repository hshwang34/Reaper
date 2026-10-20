// Viewer payments (Stripe Connect) against a fake Stripe: the fee split, the
// checkout guards, the webhook → hijack path, idempotency, and the rule that
// a viewer only pays for a hijack that actually happened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { upsertChannel } from "../src/auth.js";
import { getRuntime } from "../src/channels.js";
import { channels, db, payments } from "../src/db.js";
import { splitPayment } from "../src/fees.js";
import {
  createCheckout,
  handleWebhook,
  PaymentError,
  reconcileOnBoot,
  setStripeForTests,
  settleJob,
  type StripeLike,
} from "../src/payments.js";

// ── Fee math ──────────────────────────────────────────────────────────────

test("fees: $10 for 10s → $1.29 to us (59¢ Stripe + 20¢ GPU + 50¢ margin), $8.71 to the streamer", () => {
  const s = splitPayment(1000, 10);
  assert.deepEqual(
    [s.stripeFeeCents, s.gpuCents, s.marginCents, s.applicationFeeCents, s.streamerCents],
    [59, 20, 50, 129, 871],
  );
});

test("fees: GPU rounds up, and the fee never exceeds the payment", () => {
  assert.equal(splitPayment(300, 3, { platformFeePct: 0, gpuCostPerSec: 0.0101, stripePct: 0, stripeFixedCents: 0 }).gpuCents, 4);
  const tiny = splitPayment(50, 60);
  assert.equal(tiny.applicationFeeCents, 50);
  assert.equal(tiny.streamerCents, 0);
});

// ── Fake Stripe ───────────────────────────────────────────────────────────

const calls = { sessions: 0, refunds: [] as { pi: string; reverse: boolean; fee: boolean; key?: string }[] };
const fake: StripeLike = {
  accounts: {
    create: async () => ({ id: "acct_test" }),
    retrieve: async (id) => ({ id, capabilities: { transfers: "active" } }),
  },
  accountLinks: { create: async () => ({ url: "https://connect.stripe.test/onboard" }) },
  checkout: {
    sessions: {
      create: async (p) => {
        calls.sessions++;
        assert.equal(p.payment_intent_data?.transfer_data?.destination, "acct_paid");
        assert.ok(p.payment_intent_data?.application_fee_amount! > 0);
        return { id: `cs_test_${calls.sessions}`, url: `https://checkout.stripe.test/${calls.sessions}` };
      },
    },
  },
  refunds: {
    create: async (p, opts) => {
      calls.refunds.push({
        pi: String(p.payment_intent),
        reverse: p.reverse_transfer === true,
        fee: p.refund_application_fee === true,
        key: opts?.idempotencyKey,
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

function payableChannel(id: string) {
  upsertChannel(id, id.replace("dev:", ""), id);
  db.update(channels).set({ stripeAccountId: "acct_paid", payoutsEnabled: 1 }).where(eq(channels.id, id)).run();
  return getRuntime(id)!;
}

function paidEvent(eventId: string, sessionId: string) {
  const row = db.select().from(payments).where(eq(payments.checkoutSessionId, sessionId)).get()!;
  return Buffer.from(
    JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: sessionId,
          payment_status: "paid",
          payment_intent: `pi_${sessionId}`,
          metadata: { paymentId: row.id },
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
  // the viewer is refunded in full — transfer reversed, our fee returned.
  const before = calls.refunds.length;
  rt.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(statusOf(sessionId), "refunded");
  const r = calls.refunds[before]!;
  assert.deepEqual([r.pi, r.reverse, r.fee], [`pi_${sessionId}`, true, true]);
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
  upsertChannel("dev:orphan", "orphan", "Orphan");
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
