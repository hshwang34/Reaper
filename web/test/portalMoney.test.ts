// The amount a viewer sees on the pay button is the amount checkout charges,
// and a failed/expired claim never shows a receipt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clampToBounds, formatUsd, payLabel, showReceipt } from "../src/portal/format.js";
import { friendlyError } from "../src/lib/friendlyError.js";

test("label amount equals the clamped (charged) amount at min, max and default", () => {
  // Streamer max below the $10 default: max $6, min $2.
  for (const [pick, expected] of [[2, 2], [6, 6], [10, 6], [1, 2], [7.5, 6]] as const) {
    const charged = clampToBounds(pick, 2, 6);
    assert.equal(charged, expected);
    assert.equal(payLabel(charged, charged, "Lava Room"), `Pay ${formatUsd(expected)} · ${expected}s of Lava Room`);
  }
});

test("amounts format as whole dollars or two decimals, never $7.5", () => {
  assert.equal(formatUsd(10), "$10");
  assert.equal(formatUsd(7.5), "$7.50");
  assert.equal(formatUsd(2.25), "$2.25");
});

test("receipt only on paid, live-or-done claims; never failed or expired", () => {
  for (const s of ["pending", "review", "matched", "queued", "live", "done"] as const) assert.equal(showReceipt(s), true, s);
  for (const s of ["failed", "expired"] as const) assert.equal(showReceipt(s), false, s);
  assert.equal(showReceipt(undefined), false);
});

test("safety stops read as the streamer's rules, not our fault", () => {
  assert.equal(friendlyError("safety: output guard"), "It was stopped by the streamer's safety checks.");
  assert.match(friendlyError("something odd"), /our side/);
});
