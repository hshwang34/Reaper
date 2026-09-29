// shared/settings: the pricing formula and settings-patch hygiene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, computeDurationSec, sanitizeSettingsPatch } from "@rh/shared";

test("computeDurationSec: floor, min 1, capped", () => {
  const s = { secondsPerUSD: 1, maxDurationSec: 60 };
  assert.equal(computeDurationSec(0, s), 1);
  assert.equal(computeDurationSec(4.99, s), 4);
  assert.equal(computeDurationSec(500, s), 60);
  assert.equal(computeDurationSec(10, { secondsPerUSD: 2, maxDurationSec: 60 }), 20);
});

test("sanitizeSettingsPatch keeps known, well-typed, in-bounds fields only", () => {
  const out = sanitizeSettingsPatch({
    secondsPerUSD: 1e9, // clamped
    maxDurationSec: "60", // wrong type → dropped
    queueDepth: -5, // clamped up
    allowCustomPrompts: "yes", // wrong type → dropped
    allowSolePendingMatch: false,
    enabledPresetIds: ["lava-room", 7, "  ", "x"],
    blocklistExtra: "notalist",
    defaultPresetId: "  cyberpunk ",
    __proto__: { polluted: true },
    unknownKnob: 1,
  });
  assert.deepEqual(out, {
    secondsPerUSD: 60,
    queueDepth: 0,
    allowSolePendingMatch: false,
    enabledPresetIds: ["lava-room", "x"],
    defaultPresetId: "cyberpunk",
  });
  assert.deepEqual(sanitizeSettingsPatch(null), {});
  assert.deepEqual(sanitizeSettingsPatch("str"), {});
});

test("defaults are themselves a valid patch (round-trip)", () => {
  const out = sanitizeSettingsPatch(DEFAULT_SETTINGS);
  assert.deepEqual({ ...DEFAULT_SETTINGS, ...out }, DEFAULT_SETTINGS);
});
