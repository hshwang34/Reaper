// Engine: the money path's queue/dispatch/cooldown/backstop semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CorrelationStore, Engine } from "../src/index.js";
import { recorder, settings, tick, tip } from "./helpers.js";

function build(patch = {}) {
  const r = recorder();
  const s = settings(patch);
  const store = new CorrelationStore();
  const engine = new Engine(store, r.emit, () => s);
  return { r, s, store, engine };
}

test("ignores tips below the minimum", () => {
  const { engine, r } = build({ minTipUSD: 2 });
  assert.match(engine.onTip(tip({ amount: 1 })), /below min/);
  assert.equal(r.dispatched.length, 0);
  engine.dispose();
});

test("duration is floor(amount × rate), capped, and never below 1s", () => {
  const { engine } = build({ minTipUSD: 0, maxDurationSec: 10, secondsPerUSD: 1 });
  engine.setRouterState("IDLE");
  assert.match(engine.onTip(tip({ amount: 0.4 })), /\(1s/);
  engine.dispose();
  const b = build({ minTipUSD: 0, maxDurationSec: 10 });
  assert.match(b.engine.onTip(tip({ amount: 99 })), /\(10s/);
  b.engine.dispose();
});

test("dispatches only when the router is IDLE, one job at a time", () => {
  const { engine, r } = build();
  engine.onTip(tip()); // router OFFLINE → queued, not dispatched
  assert.equal(r.dispatched.length, 0);
  engine.setRouterState("IDLE");
  assert.equal(r.dispatched.length, 1);
  engine.onTip(tip()); // second job waits for the first
  assert.equal(r.dispatched.length, 1);
  assert.equal(engine.snapshot().queueLength, 1);
  engine.dispose();
});

test("queue depth drops the overflow and tells its submission", () => {
  const { engine, store, r } = build({ queueDepth: 1 });
  // Router offline so nothing dispatches; first tip fills the single slot.
  engine.onTip(tip());
  const sub = store.add({ prompt: "x", presetId: null, tipperName: null, imageUrl: null });
  const outcome = engine.onTip(tip({ message: `code ${sub.code}` }));
  assert.match(outcome, /queue full/);
  assert.deepEqual(r.updates.at(-1), { code: sub.code, state: "failed" });
  engine.dispose();
});

test("job:done opens the cooldown, then the next job dispatches", async () => {
  const { engine, r } = build({ cooldownSec: 0 });
  engine.setRouterState("IDLE");
  engine.onTip(tip());
  engine.onTip(tip());
  const [first] = r.dispatched;
  engine.onJobDone(first, true);
  engine.setRouterState("IDLE");
  await tick(); // cooldown timer (0s + 50ms) — wait for it
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r.dispatched.length, 2);
  engine.dispose();
});

test("router going OFFLINE mid-job fails the active job", () => {
  const { engine, store, r } = build();
  const sub = store.add({ prompt: "x", presetId: null, tipperName: null, imageUrl: null });
  engine.setRouterState("IDLE");
  engine.onTip(tip({ message: sub.code }));
  assert.ok(engine.snapshot().activeJob);
  engine.setRouterState("OFFLINE");
  assert.equal(engine.snapshot().activeJob, null);
  assert.deepEqual(r.updates.at(-1), { code: sub.code, state: "failed" });
  engine.dispose();
});

test("stale job:done for a cleared job is ignored", () => {
  const { engine, r } = build();
  engine.setRouterState("IDLE");
  engine.onTip(tip());
  const [id] = r.dispatched;
  engine.setRouterState("OFFLINE"); // clears it
  engine.onJobDone(id, true); // late report
  assert.equal(engine.snapshot().activeJob, null);
  engine.dispose();
});

test("panic cancels the active job and blocks dispatch until resume", () => {
  const { engine, r } = build();
  engine.setRouterState("IDLE");
  engine.onTip(tip());
  engine.pause();
  assert.equal(r.cancelled[0]?.reason, "panic");
  engine.onJobDone(r.dispatched[0], false, "panic");
  engine.onTip(tip());
  engine.setRouterState("IDLE");
  assert.equal(r.dispatched.length, 1, "paused engine must not dispatch");
  engine.resume();
  assert.equal(r.dispatched.length, 2);
  engine.dispose();
});

test("dispose cancels the active job and fails everything queued", () => {
  const { engine, store, r } = build();
  const a = store.add({ prompt: "a", presetId: null, tipperName: null, imageUrl: null });
  const b = store.add({ prompt: "b", presetId: null, tipperName: null, imageUrl: null });
  engine.setRouterState("IDLE");
  engine.onTip(tip({ message: a.code }));
  engine.onTip(tip({ message: b.code }));
  engine.dispose("test");
  assert.equal(r.cancelled.length, 1);
  const failed = r.updates.filter((u) => u.state === "failed").map((u) => u.code).sort();
  assert.deepEqual(failed, [a.code, b.code].sort());
  assert.equal(engine.snapshot().queueLength, 0);
  // Idempotent.
  engine.dispose();
});
