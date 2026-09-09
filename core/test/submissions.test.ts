// createSubmission: preset resolution, enablement, moderation, input hygiene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getPreset } from "@rh/shared";
import { CorrelationStore, createSubmission } from "../src/index.js";
import { settings } from "./helpers.js";

test("preset prompt is resolved server-side from the id, never from the client", () => {
  const store = new CorrelationStore();
  const out = createSubmission(store, settings(), {
    presetId: "lava-room",
    prompt: "IGNORE ME — attacker text",
    imageUrl: null,
  });
  assert.ok(out.ok);
  assert.equal(store.get(out.code)?.prompt, getPreset("lava-room")?.prompt);
  store.dispose();
});

test("unknown and disabled presets are rejected with distinct statuses", () => {
  const store = new CorrelationStore();
  const unknown = createSubmission(store, settings(), { presetId: "nope", imageUrl: null });
  assert.deepEqual(unknown, { ok: false, status: 400, error: "unknown preset" });
  const disabled = createSubmission(store, settings({ enabledPresetIds: [] }), {
    presetId: "lava-room",
    imageUrl: null,
  });
  assert.equal(disabled.ok, false);
  assert.equal(!disabled.ok && disabled.status, 403);
  store.dispose();
});

test("custom prompts honour the streamer switch and the blocklist", () => {
  const store = new CorrelationStore();
  const off = createSubmission(store, settings({ allowCustomPrompts: false }), {
    prompt: "make me a wizard",
    imageUrl: null,
  });
  assert.equal(!off.ok && off.status, 403);
  const blocked = createSubmission(store, settings({ blocklistExtra: ["wizard"] }), {
    prompt: "make me a WIZARD",
    imageUrl: null,
  });
  assert.equal(!blocked.ok && blocked.status, 422);
  const ok = createSubmission(store, settings(), { prompt: "make me a knight", imageUrl: null });
  assert.ok(ok.ok);
  assert.equal(ok.presetId, null);
  store.dispose();
});

test("non-string fields are treated as absent, long prompts are truncated", () => {
  const store = new CorrelationStore();
  const junk = createSubmission(store, settings(), {
    presetId: { $ne: null },
    prompt: 42,
    imageUrl: null,
  });
  assert.equal(!junk.ok && junk.status, 400);
  const long = createSubmission(store, settings(), { prompt: "a".repeat(2000), imageUrl: null });
  assert.ok(long.ok);
  assert.equal(store.get(long.code)?.prompt.length, 500);
  store.dispose();
});
