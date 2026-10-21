// Tray status is plain words, never the engine's raw state names.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS } from "@rh/shared";
import { effectIsLive, trayMenuLabel, trayState, trayStatusText, trayTooltip } from "../src/main/trayCopy.js";

const snap = (o: Partial<Parameters<typeof trayState>[0]> = {}) => ({
  routerState: "IDLE" as const,
  paused: false,
  queueLength: 0,
  activeJob: null,
  ...o,
});

test("states read as Ready / Live / Paused / Not connected", () => {
  assert.equal(trayStatusText(snap()), "Ready");
  assert.equal(trayStatusText(snap({ routerState: "OFFLINE" })), "Not connected");
  assert.equal(trayStatusText(snap({ paused: true })), "Paused");
  // Paused wins even when the router is gone or an effect is up.
  assert.equal(trayStatusText(snap({ paused: true, routerState: "OFFLINE" })), "Paused");
  // In-between engine states are just "Ready" to a human, never TEARDOWN etc.
  for (const s of ["AUTHORIZING", "CONNECTING", "BUFFERING", "TEARDOWN"] as const) {
    assert.doesNotMatch(trayStatusText(snap({ routerState: s })), /AUTHORIZING|CONNECTING|BUFFERING|TEARDOWN/);
  }
});

test("live names the effect: a preset by label, anything else as a custom effect", () => {
  const p = PRESETS[0]!;
  const live = (prompt: string) => snap({ routerState: "LIVE", activeJob: { jobId: "j", prompt, remainingSec: 5 } });
  assert.equal(trayStatusText(live(p.prompt)), `Live: ${p.label}`);
  assert.equal(trayStatusText(live("my own words")), "Live: custom effect");
});

test("menu row and tooltip use 'in line', not 'queue'", () => {
  assert.equal(trayMenuLabel(snap({ queueLength: 2 })), "Status: Ready · 2 in line");
  assert.equal(trayMenuLabel(snap()), "Status: Ready");
  assert.equal(trayTooltip(snap({ queueLength: 1 })), "Stream Hijack — Ready · 1 in line");
  assert.doesNotMatch(trayTooltip(snap({ queueLength: 3 })), /queue/i);
});

test("effectIsLive gates the 'Run setup again' confirm", () => {
  assert.equal(effectIsLive(snap()), false);
  assert.equal(effectIsLive(snap({ routerState: "LIVE" })), true);
  assert.equal(effectIsLive(snap({ activeJob: { jobId: "j", prompt: "x", remainingSec: 1 } })), true);
});
