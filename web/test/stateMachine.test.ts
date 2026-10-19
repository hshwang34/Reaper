// RouterMachine under fakes: the invariants CLAUDE.md calls out, asserted.
//   · teardown is idempotent and every exit path funnels through it
//   · OBS is hidden BEFORE the Decart session drops
//   · aborts before LIVE never unhide OBS
//   · a cancel that races an in-flight unhide still ends hidden
//   · dispose() mid-job ends OFFLINE, never IDLE

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientMsg, HijackJob, JobDoneMsg, RouterState } from "@rh/shared";
import { RouterMachine } from "../src/router/stateMachine.js";
import type { MachinePorts, DecartPort, GuardVerdict } from "../src/router/ports.js";
import { verdictFrom } from "../src/router/frameGuard.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const fakeStream = () =>
  ({ getVideoTracks: () => [{ readyState: "live", muted: false }] }) as unknown as MediaStream;
const fakeCamera = () =>
  ({ getTracks: () => [{ stop() {} }], getVideoTracks: () => [] }) as unknown as MediaStream;

function job(patch: Partial<HijackJob> = {}): HijackJob {
  return {
    jobId: "job-1",
    prompt: "lava",
    presetId: null,
    imageUrl: null,
    enhance: true,
    durationSec: 1,
    tip: { source: "fake", amount: 1, message: "", username: "v" },
    matchedBy: "default-preset",
    ...patch,
  };
}

interface Harness {
  machine: RouterMachine;
  calls: string[];
  states: RouterState[];
  sent: ClientMsg[];
  /** Deliver the "Decart" remote stream to the machine. */
  emitStream(): void;
  ports: MachinePorts;
  done(): JobDoneMsg | undefined;
  /** Make the LIVE-phase guard sampler report a positive. */
  guardFire(v?: GuardVerdict): void;
}

type Overrides = Partial<Omit<MachinePorts, "decart">> & { decart?: Partial<DecartPort> };

function harness(over: Overrides = {}, timeouts = {}): Harness {
  const calls: string[] = [];
  const states: RouterState[] = [];
  const sent: ClientMsg[] = [];
  let remote: ((s: MediaStream) => void) | null = null;
  let onUnsafe: ((v: GuardVerdict) => void) | null = null;
  const ports: MachinePorts = {
    guard: {
      ready: async () => true,
      check: async () => {
        calls.push("guard:check");
        return { unsafe: false, label: "ok", score: 0.01 };
      },
      watch: (_s, cb) => {
        calls.push("guard:watch");
        onUnsafe = cb;
        return () => calls.push("guard:stop");
      },
    },
    mintToken: async () => "MOCK",
    setObsVisible: async (v) => {
      calls.push(`obs:${v}`);
    },
    fetchImage: async () => null,
    decart: {
      start: async (a) => {
        calls.push("decart:start");
        remote = a.onRemoteStream;
      },
      disconnect: () => {
        calls.push("decart:disconnect");
      },
      ...over.decart,
    },
    sender: {
      start: async (_id, _stream, overlay) => {
        calls.push(overlay ? `sender:start:${JSON.stringify(overlay)}` : "sender:start");
      },
      sendReset: () => {
        calls.push("sender:reset");
      },
      stop: () => {
        calls.push("sender:stop");
      },
    },
    send: (m) => {
      sent.push(m);
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "decart")),
  };
  const machine = new RouterMachine(
    ports,
    { onState: (s) => states.push(s), log: () => {} },
    { wipeMs: 10, connectMs: 200, bufferMs: 200, watchdogExtraMs: 500, ...timeouts },
  );
  machine.setCamera(fakeCamera());
  return {
    machine,
    calls,
    states,
    sent,
    ports,
    emitStream: () => remote?.(fakeStream()),
    done: () => sent.find((m): m is JobDoneMsg => m.t === "job:done"),
    guardFire: (v = { unsafe: true, label: "Porn", score: 0.93 }) => onUnsafe?.(v),
  };
}

const guarded = (mode: "on" | "required", trusted = false): Partial<HijackJob> => ({
  safety: { outputGuard: mode, trusted, attribution: "alice", aiLabel: true },
});

test("happy path: unhide only after frames-ok; hide → disconnect on completion", async () => {
  const h = harness();
  void h.machine.runJob(job({ durationSec: 1 }));
  await tick();
  assert.deepEqual(h.states.slice(1), ["AUTHORIZING", "CONNECTING"]);
  h.emitStream();
  await tick();
  assert.equal(h.machine.getState(), "BUFFERING");
  assert.ok(!h.calls.includes("obs:true"), "OBS must stay hidden until frames-ok");
  h.machine.onFramesOk("job-1");
  await tick();
  assert.equal(h.machine.getState(), "LIVE");
  await tick(1300);
  assert.equal(h.machine.getState(), "IDLE");
  const order = h.calls.filter((c) => c.startsWith("obs") || c === "sender:reset" || c === "decart:disconnect");
  assert.deepEqual(order, ["obs:true", "sender:reset", "obs:false", "decart:disconnect"]);
  assert.deepEqual(h.done(), { t: "job:done", jobId: "job-1", ok: true, reason: "completed" });
});

test("mint failure aborts without ever touching OBS", async () => {
  const h = harness({ mintToken: async () => { throw new Error("nope"); } });
  await h.machine.runJob(job());
  await tick();
  assert.equal(h.machine.getState(), "IDLE");
  assert.ok(!h.calls.some((c) => c.startsWith("obs")));
  assert.match(String(h.done()?.reason), /token mint failed/);
});

test("connect timeout aborts, and a late connect result cannot re-enter", async () => {
  let resolveStart!: () => void;
  const h = harness(
    { decart: { start: () => new Promise<void>((r) => { resolveStart = r; }) } },
    { connectMs: 30 },
  );
  void h.machine.runJob(job());
  await tick(60);
  assert.equal(h.machine.getState(), "IDLE");
  assert.match(String(h.done()?.reason), /connect timeout/);
  assert.ok(h.calls.includes("decart:disconnect"));
  const before = h.states.length;
  resolveStart();
  await tick();
  assert.equal(h.states.length, before, "stale continuation must not change state");
});

test("no verified frames → abort, OBS never shown", async () => {
  const h = harness({}, { bufferMs: 30 });
  void h.machine.runJob(job());
  await tick();
  h.emitStream();
  await tick(60);
  assert.equal(h.machine.getState(), "IDLE");
  assert.ok(!h.calls.includes("obs:true"));
  assert.match(String(h.done()?.reason), /no verified frames/);
});

test("panic while the unhide request is in flight still ends with OBS hidden", async () => {
  let resolveShow!: () => void;
  const h = harness({
    setObsVisible: (v) => {
      h.calls.push(`obs:${v}`);
      return v ? new Promise<void>((r) => { resolveShow = r; }) : Promise.resolve();
    },
  });
  void h.machine.runJob(job());
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick();
  // Unhide is pending; the streamer hits panic.
  h.machine.cancel("job-1", "panic");
  await tick();
  assert.ok(!h.states.includes("LIVE"));
  resolveShow();
  await tick();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("obs")), ["obs:true", "obs:false"]);
  assert.equal(h.done()?.ok, false);
});

test("teardown is idempotent: repeated cancels produce one job:done", async () => {
  const h = harness();
  void h.machine.runJob(job());
  await tick();
  h.machine.cancel("job-1", "a");
  h.machine.cancel("job-1", "b");
  h.machine.cancel("job-1", "c");
  await tick();
  assert.equal(h.sent.filter((m) => m.t === "job:done").length, 1);
});

test("dispose during LIVE hides, disconnects, and ends OFFLINE (never IDLE)", async () => {
  const h = harness();
  void h.machine.runJob(job({ durationSec: 5 }));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick();
  assert.equal(h.machine.getState(), "LIVE");
  await h.machine.dispose();
  assert.equal(h.machine.getState(), "OFFLINE");
  const order = h.calls.filter((c) => c === "obs:false" || c === "decart:disconnect");
  assert.deepEqual(order, ["obs:false", "decart:disconnect"]);
  assert.ok(!h.states.slice(h.states.indexOf("TEARDOWN")).includes("IDLE"));
});

test("an overlapping job is failed back explicitly", async () => {
  const h = harness();
  void h.machine.runJob(job({ jobId: "a" }));
  await tick();
  await h.machine.runJob(job({ jobId: "b" }));
  const b = h.sent.find((m) => m.t === "job:done" && m.jobId === "b");
  assert.deepEqual(b, { t: "job:done", jobId: "b", ok: false, reason: "router busy" });
  h.machine.cancel("a", "cleanup");
});

test("duplicate frames-ok (two viewer pages) goes LIVE once, and its timers can't kill the next job", async () => {
  let resolveShow!: () => void;
  let shows = 0;
  const h = harness(
    {
      setObsVisible: (v) => {
        h.calls.push(`obs:${v}`);
        if (!v) return Promise.resolve();
        shows++;
        return new Promise<void>((r) => { resolveShow = r; });
      },
    },
    { watchdogExtraMs: 300 },
  );
  void h.machine.runJob(job({ durationSec: 1 }));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  h.machine.onFramesOk("job-1"); // second viewer, while the unhide is in flight
  await tick();
  assert.equal(shows, 1, "OBS unhidden exactly once");
  resolveShow();
  await tick(1100); // job-1 completes → IDLE
  assert.equal(h.machine.getState(), "IDLE");

  // Job 2 starts and goes LIVE; any leaked job-1 watchdog (1s + 300ms after
  // its start) must not tear it down.
  void h.machine.runJob(job({ jobId: "job-2", durationSec: 1 }));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-2");
  await tick();
  resolveShow();
  await tick(400);
  assert.equal(h.machine.getState(), "LIVE", "job-2 still running");
  const done = h.sent.filter((m): m is JobDoneMsg => m.t === "job:done");
  assert.deepEqual(done.map((d) => d.jobId), ["job-1"]);
});

test("the viewer's enhance choice and reference image reach the Decart session", async () => {
  let seen: { enhance?: boolean; image?: Blob | null } = {};
  const img = new Blob(["x"], { type: "image/jpeg" });
  const h = harness({
    fetchImage: async () => img,
    decart: {
      start: async (a) => {
        seen = { enhance: a.enhance, image: a.imageBlob };
      },
    },
  });
  void h.machine.runJob(job({ enhance: false, imageUrl: "http://cloud/uploads/c/x.jpg" }));
  await tick();
  assert.equal(seen.enhance, false);
  assert.equal(seen.image, img);
  h.machine.cancel("job-1", "test");
  await tick();
});

// ── Output guard (CONTENT-SAFETY S4) ─────────────────────────────────────

test("guard: an unsafe first frame aborts inside the buffering gate — OBS never shown", async () => {
  const h = harness({
    guard: {
      ready: async () => true,
      check: async () => ({ unsafe: true, label: "Porn", score: 0.97 }),
      watch: () => () => {},
    },
  });
  void h.machine.runJob(job(guarded("on")));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick();
  assert.equal(h.machine.getState(), "IDLE");
  assert.ok(!h.calls.includes("obs:true"), "never unhidden");
  assert.match(String(h.done()?.reason), /^safety: output guard Porn 0\.97/);
});

test("guard: a positive during LIVE hides before disconnect and stops the sampler", async () => {
  const h = harness();
  void h.machine.runJob(job({ ...guarded("on"), durationSec: 5 }));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick();
  assert.equal(h.machine.getState(), "LIVE");
  assert.ok(h.calls.includes("guard:check") && h.calls.includes("guard:watch"));
  h.guardFire();
  await tick(40);
  assert.equal(h.machine.getState(), "IDLE");
  const order = h.calls.filter((c) => ["obs:false", "decart:disconnect", "guard:stop"].includes(c));
  assert.deepEqual(order, ["guard:stop", "obs:false", "decart:disconnect"]);
  assert.match(String(h.done()?.reason), /^safety: output guard Porn/);
  // A late sampler callback after teardown is inert.
  h.guardFire();
  await tick();
  assert.equal(h.sent.filter((m) => m.t === "job:done").length, 1);
});

test("guard: required + viewer content + guard unavailable → abort; trusted presets still run", async () => {
  const unavailable = {
    guard: {
      ready: async () => false,
      check: async () => ({ unsafe: false, label: "ok", score: 0 }),
      watch: () => () => {},
    },
  };
  const h = harness(unavailable);
  void h.machine.runJob(job(guarded("required", false)));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick();
  assert.ok(!h.calls.includes("obs:true"));
  assert.match(String(h.done()?.reason), /^safety: output guard unavailable/);

  const t = harness(unavailable);
  void t.machine.runJob(job(guarded("required", true)));
  await tick();
  t.emitStream();
  await tick();
  t.machine.onFramesOk("job-1");
  await tick();
  assert.equal(t.machine.getState(), "LIVE", "a trusted preset runs without the guard");
  t.machine.cancel("job-1", "test");
  await tick(30);
});

test("guard: a hung model load can't stall the gate past its budget", async () => {
  const h = harness(
    {
      guard: {
        ready: () => new Promise<boolean>(() => {}),
        check: async () => ({ unsafe: false, label: "ok", score: 0 }),
        watch: () => () => {},
      },
    },
    { guardMs: 20 },
  );
  void h.machine.runJob(job(guarded("on")));
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick(50);
  assert.equal(h.machine.getState(), "LIVE", "'on' runs without the guard when it can't load");
  h.machine.cancel("job-1", "test");
  await tick(30);
});

test("guard off: no check, no watch; overlay chips ride the sender start", async () => {
  const h = harness();
  void h.machine.runJob(job());
  await tick();
  h.emitStream();
  await tick();
  h.machine.onFramesOk("job-1");
  await tick();
  assert.ok(!h.calls.some((c) => c.startsWith("guard")));
  h.machine.cancel("job-1", "test");
  await tick(30);

  const o = harness();
  void o.machine.runJob(job(guarded("on")));
  await tick();
  o.emitStream();
  await tick();
  assert.ok(o.calls.includes('sender:start:{"attribution":"alice","aiLabel":true}'));
  o.machine.cancel("job-1", "test");
  await tick(30);
});

test("verdictFrom: explicit classes sum; 'Sexy' alone needs high confidence; drawings are fine", () => {
  const p = (o: Record<string, number>) =>
    Object.entries(o).map(([className, probability]) => ({ className, probability }));
  assert.equal(verdictFrom(p({ Porn: 0.4, Hentai: 0.3, Neutral: 0.3 })).unsafe, true);
  assert.equal(verdictFrom(p({ Sexy: 0.7, Neutral: 0.3 })).unsafe, false);
  assert.equal(verdictFrom(p({ Sexy: 0.9 })).label, "Sexy");
  assert.equal(verdictFrom(p({ Drawing: 0.95, Hentai: 0.04 })).unsafe, false);
});
