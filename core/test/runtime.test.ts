// createRuntime: the host hooks every composition root relies on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import { settings, tip } from "./helpers.js";

test("an engine-side cancel reaches onCancelJob, so a host can hide OBS itself", () => {
  const cancels: string[] = [];
  const s = settings();
  const rt = createRuntime({
    getSettings: () => s,
    server: null,
    hooks: { onCancelJob: (jobId, reason) => cancels.push(`${jobId}:${reason}`) },
  });
  rt.engine.setRouterState("IDLE");
  rt.engine.onTip(tip());
  const active = rt.engine.snapshot().activeJob;
  assert.ok(active, "tip should be dispatched");
  rt.engine.togglePause(); // panic with a job in flight → cancel
  assert.equal(cancels.length, 1);
  assert.match(cancels[0], new RegExp(`^${active.jobId}:`));
  rt.dispose();
});
