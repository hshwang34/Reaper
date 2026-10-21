// What streamers read about a hijack's fate and about blocked / parked
// requests (web/src/lib/streamerCopy.ts + features/SafetyPanels.tsx): the
// BRAND §3 end-state words, no raw engine or classifier text, and — the one
// that must never regress — a suspected-CSAM quarantine reason NEVER renders
// in any streamer-facing list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModerationEvent } from "@rh/shared";
import { blockedDetail, effectName, hijackReason, hijackResult, reviewWhy } from "../src/lib/streamerCopy.js";
import { BlockedList } from "../src/features/SafetyPanels.js";

const ev = (over: Partial<ModerationEvent>): ModerationEvent => ({
  id: "e1",
  ts: 1_700_000_000_000,
  stage: "image",
  verdict: "reject",
  source: "sightengine",
  reason: "blocked",
  categories: [],
  tipper: "mika",
  ...over,
});

test("hijack end states use the BRAND words (Played / Didn't play / Refunded / In progress)", () => {
  assert.equal(hijackResult({ outcome: "completed", reason: null }).label, "Played");
  assert.equal(hijackResult({ outcome: "failed", reason: "hijack failed: boom" }).label, "Didn't play");
  assert.equal(hijackResult({ outcome: "failed", reason: "refunded: never started" }).label, "Refunded");
  assert.equal(hijackResult({ outcome: "refunded" }).label, "Refunded");
  assert.equal(hijackResult({ outcome: "dispatched", reason: null }).label, "In progress");
  assert.equal(hijackResult({ outcome: "something-new" }).label, "In progress");
});

test("row reasons are mapped to labels; raw engine text is dropped", () => {
  assert.equal(hijackReason({ outcome: "failed", reason: "safety: output guard nsfw 0.91" }), "Stopped by your rules");
  assert.equal(hijackReason({ outcome: "failed", reason: "The streamer declined this effect." }), "Declined by you");
  assert.equal(hijackReason({ outcome: "failed", reason: "DecartError: token mint failed" }), null);
  assert.equal(hijackReason({ outcome: "completed", reason: null }), null);
});

test("review reasons never echo engine text", () => {
  assert.equal(reviewWhy("approval tier"), "Custom effect");
  assert.equal(reviewWhy("likeness swap"), "Face swap");
  assert.equal(reviewWhy("openai: sexual/minors 0.4"), "Needs your OK");
});

test("custom prompts read as 'Custom effect'", () => {
  assert.equal(effectName("make the room a volcano nobody asked for"), "Custom effect");
});

test("Recently blocked: category labels, never the raw reason", () => {
  assert.equal(blockedDetail(ev({ stage: "text", source: "blocklist", categories: ["blocklist"] })), "Blocked word");
  assert.equal(blockedDetail(ev({ stage: "review", categories: [] })), null);
  assert.equal(blockedDetail(ev({ stage: "report", categories: [], reason: "viewer typed anything here" })), null);
});

test("a suspected-CSAM quarantine reason is never rendered in a streamer list", () => {
  const csam = ev({
    id: "c1",
    source: "sightengine",
    reason: "suspected CSAM — runbook",
    categories: ["csam-suspected"],
  });
  const takedown = ev({ id: "t1", source: "takedown-list", reason: "previously removed image", categories: ["blocked-hash"] });
  assert.equal(blockedDetail(csam), null);
  assert.equal(blockedDetail(takedown), null);
  const html = renderToStaticMarkup(createElement(BlockedList, { events: [csam, takedown], banned: new Set<string>() }));
  assert.doesNotMatch(html, /csam|runbook|suspected|previously removed|takedown|blocked-hash/i);
  assert.match(html, /Photo blocked/); // the row itself still shows, minus the reason
});
