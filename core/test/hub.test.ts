// Hub: role validation and per-role gating of control + local-plane traffic.
// Uses adopted mode with fake sockets so no server is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { Hub, type HubHandlers } from "../src/index.js";
import { FakeSocket } from "./helpers.js";

function build(opts = {}) {
  const calls: string[] = [];
  const handlers: HubHandlers = {
    onRouterState: (s) => calls.push(`state:${s}`),
    onJobDone: (id, ok) => calls.push(`done:${id}:${ok}`),
    onRouterDisconnected: () => calls.push("router-gone"),
    getStatus: () => ({ routerState: "IDLE", activeJob: null, queueLength: 0, paused: false }),
  };
  const hub = new Hub(null, handlers, opts);
  const join = (role: unknown, extra = {}) => {
    const ws = new FakeSocket();
    hub.adopt(ws as unknown as WebSocket, { t: "hello", role, ...extra } as never);
    return ws;
  };
  return { hub, calls, join };
}

test("an unknown role is refused instead of crashing the process", () => {
  const { join } = build();
  const ws = join("admin");
  assert.equal(ws.closedWith?.code, 4400);
  const ws2 = join(undefined);
  assert.equal(ws2.closedWith?.code, 4400);
});

test("a malformed frame from a registered socket is ignored, not thrown", () => {
  const { join } = build();
  const ws = join("portal");
  assert.doesNotThrow(() => ws.receive(null));
  assert.doesNotThrow(() => ws.receive({ t: 42 }));
  assert.doesNotThrow(() => ws.receive("garbage"));
});

test("privileged roles need the auth token; portal never does", () => {
  const { join } = build({ authToken: "secret" });
  assert.equal(join("router").closedWith?.code, 4401);
  assert.equal(join("router", { auth: "secret" }).closedWith, null);
  assert.equal(join("portal").closedWith, null);
});

test("only the router may report router:state / job:done", () => {
  const { join, calls } = build();
  const portal = join("portal");
  const viewer = join("viewer");
  const router = join("router");
  portal.receive({ t: "router:state", state: "OFFLINE" });
  viewer.receive({ t: "job:done", jobId: "j", ok: false });
  assert.deepEqual(calls, [], "forged control messages must be dropped");
  router.receive({ t: "router:state", state: "LIVE" });
  router.receive({ t: "job:done", jobId: "j", ok: true });
  assert.deepEqual(calls, ["state:LIVE", "done:j:true"]);
});

test("frames-ok reaches the router only when the viewer sends it", () => {
  const { join } = build();
  const router = join("router");
  const portal = join("portal");
  const viewer = join("viewer");
  router.sent.length = 0;
  portal.receive({ t: "viewer:frames-ok", jobId: "j" });
  router.receive({ t: "viewer:frames-ok", jobId: "j" });
  assert.equal(router.sent.length, 0);
  viewer.receive({ t: "viewer:frames-ok", jobId: "j" });
  assert.deepEqual(router.sent, [{ t: "viewer:frames-ok", jobId: "j" }]);
});

test("rtc signaling is relayed router ↔ viewer with the real sender stamped", () => {
  const { join } = build();
  const router = join("router");
  const viewer = join("viewer");
  const portal = join("portal");
  viewer.sent.length = 0;
  router.sent.length = 0;
  router.receive({ t: "rtc:offer", target: "viewer", jobId: "j", sdp: {}, from: "portal" });
  assert.equal((viewer.sent[0] as { from: string }).from, "router");
  portal.receive({ t: "rtc:candidate", target: "viewer", jobId: "j", candidate: {} });
  assert.equal(viewer.sent.length, 1, "portal must not inject signaling");
  viewer.receive({ t: "rtc:answer", target: "viewer", jobId: "j", sdp: {} });
  assert.equal(viewer.sent.length, 1, "a peer may not target its own role");
});

test("hosted mode drops the whole local plane", () => {
  const { join } = build({ rejectLocalPlane: true });
  const router = join("router");
  const viewer = join("viewer");
  router.sent.length = 0;
  viewer.receive({ t: "viewer:frames-ok", jobId: "j" });
  viewer.receive({ t: "rtc:answer", target: "router", jobId: "j", sdp: {} });
  assert.equal(router.sent.length, 0);
});

test("router disconnect is reported once the last router leaves; close() drops everyone", () => {
  const { hub, join, calls } = build();
  const a = join("router");
  const b = join("router");
  a.close();
  assert.deepEqual(calls, []);
  b.close();
  assert.deepEqual(calls, ["router-gone"]);
  const portal = join("portal");
  hub.close();
  assert.equal(portal.closedWith?.code, 1012);
  assert.equal(hub.routerOnline, false);
});
