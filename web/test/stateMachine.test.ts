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
import type { MachinePorts, DecartPort } from "../src/router/ports.js";

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
}

type Overrides = Partial<Omit<MachinePorts, "decart">> & { decart?: Partial<DecartPort> };

function harness(over: Overrides = {}, timeouts = {}): Harness {
  const calls: string[] = [];
  const states: RouterState[] = [];
  const sent: ClientMsg[] = [];
  let remote: ((s: MediaStream) => void) | null = null;
  const ports: MachinePorts = {
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
      start: async () => {
        calls.push("sender:start");
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
  };
}

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
