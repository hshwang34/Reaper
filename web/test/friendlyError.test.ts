// friendlyError: raw network/server text never reaches a viewer (BRAND §5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK, friendlyError, friendlyStreamerError } from "../src/lib/friendlyError.js";

test("network failures say what to do", () => {
  assert.match(friendlyError(new TypeError("Failed to fetch")), /couldn't reach the server/);
  assert.match(friendlyError(new Error("NetworkError when attempting to fetch resource.")), /Check your connection/);
});

test("known server messages keep their meaning in plain words", () => {
  assert.match(friendlyError("that effect expired — submit it again"), /expired before you paid/);
  assert.match(friendlyError("the streamer's Stream Hijack app isn't running right now — try again when they're live"), /payments are paused/);
  assert.match(friendlyError("confirm you have consent to use this person's likeness"), /Check the consent box/);
  assert.match(friendlyError("minimum is $2.00"), /below the minimum/);
});

test("status codes map when the message is unknown; 5xx and unknown use the fallback", () => {
  const withStatus = (m: string, status: number) => Object.assign(new Error(m), { status });
  assert.match(friendlyError(withStatus("HTTP 429", 429)), /a bit fast/);
  assert.match(friendlyError(withStatus("boom", 413)), /5 MB/);
  assert.equal(friendlyError(withStatus("kaboom", 502)), FALLBACK);
  assert.equal(friendlyError("DecartError: token mint failed"), FALLBACK);
  assert.equal(friendlyError(undefined), FALLBACK);
});

test("no vendor or jargon leaks through the fallback", () => {
  assert.doesNotMatch(FALLBACK, /decart|token|mint|http/i);
});

test("engine end-of-hijack messages map to plain words and never hit the fallback", () => {
  assert.equal(friendlyError("The effect was stopped by the stream's safety filter."), "It was stopped by the streamer's safety checks.");
  assert.equal(friendlyError("It was stopped by the streamer's safety checks."), "It was stopped by the streamer's safety checks.");
  assert.equal(friendlyError("The streamer declined this effect."), "The streamer declined this effect.");
  assert.equal(friendlyError("The streamer didn't approve this effect in time."), "The streamer didn't approve this effect in time.");
  assert.equal(friendlyError("Hijack failed: router never reported completion"), "It didn't play.");
  assert.equal(friendlyError("Hijack cancelled: panic"), "It was cancelled before it played.");
  assert.match(friendlyError("The line is full right now. Try again in a minute."), /line is full/);
  assert.match(friendlyError("The streamer has too many effects waiting for approval. Try again in a minute."), /too many effects/);
  assert.equal(friendlyError("Stripe returned no checkout URL"), "We couldn't start checkout. Try again.");
  assert.equal(friendlyError("That photo is over 25 MB. Pick a smaller one."), "That photo is over 25 MB. Pick a smaller one.");
  assert.equal(friendlyError("something went wrong — try again"), FALLBACK);
  assert.doesNotMatch(friendlyError("Hijack failed: boom"), /boom/);
});

test("rewritten server strings still map (payments + submissions)", () => {
  assert.match(friendlyError("hshwang34 isn't live right now. Try again when they're streaming."), /payments are paused/);
  assert.match(friendlyError("That effect expired. Pick it again."), /expired before you paid/);
  assert.match(friendlyError("That effect doesn't exist."), /doesn't exist/);
  assert.match(friendlyError("Pick an effect or describe your own."), /Pick an effect or describe/);
  assert.match(friendlyError("This effect needs a photo."), /needs a photo/);
  assert.match(friendlyError("Photos are off on this stream."), /turned off photos/);
  assert.match(friendlyError("Custom effects are off on this stream."), /turned off custom ideas/);
  assert.match(friendlyError("Custom effects are off right now. Pick an effect instead."), /aren't available right now/);
});

test("server 413 says 5 MB (the real upload cap); the client-side pick limit stays 25 MB", () => {
  assert.equal(friendlyError(Object.assign(new Error("x"), { status: 413 })), "That photo is over 5 MB. Pick a smaller one.");
  assert.equal(friendlyError("That photo is over 5 MB. Pick a smaller one."), "That photo is over 5 MB. Pick a smaller one.");
  assert.equal(friendlyError("image too large"), "That photo is over 5 MB. Pick a smaller one.");
});

test("streamer errors: IPC wrappers, HTTP 5xx, camera DOMExceptions, engine outcomes", () => {
  const ipc = (m: string) => new Error(`Error invoking remote method 'rh:x': Error: ${m}`);
  assert.equal(friendlyStreamerError(ipc("HTTP 503")), "The server isn't answering. Try again in a moment.");
  assert.equal(friendlyStreamerError(Object.assign(new Error("boom"), { status: 502 })), "The server isn't answering. Try again in a moment.");
  const dom = (name: string) => Object.assign(new Error("Permission denied"), { name });
  assert.match(friendlyStreamerError(dom("NotAllowedError")), /Camera access was blocked/);
  assert.match(friendlyStreamerError(Object.assign(new Error("Requested device not found"), { name: "NotFoundError" })), /Start OBS's Virtual Camera/);
  assert.match(friendlyStreamerError(ipc("OBS isn't in its default install location — start it yourself and this page connects on its own.")), /couldn't find OBS/);
  assert.equal(friendlyStreamerError("queued (10s, manual)"), "Starting…");
  assert.equal(friendlyStreamerError("dropped: queue full"), "The line is full. Try again in a moment.");
  assert.equal(friendlyStreamerError("today's free test hijack is used — it resets at 00:00 UTC"), "You've used today's free test. It resets at midnight UTC.");
  // keeps non-5xx status mapping through the IPC unwrap
  assert.match(friendlyStreamerError(Object.assign(ipc("x"), { status: 429 })), /a bit fast/);
});

test("no raw engineering text survives either mapper", () => {
  const raws = ["HTTP 500", "DOMException: boom", "queued (10s, manual)", "TypeError: x is undefined\n    at foo (bar.js:1:2)", "Error invoking remote method 'rh:q': Error: kaboom"];
  for (const r of raws) {
    for (const out of [friendlyError(r), friendlyStreamerError(r)]) {
      assert.doesNotMatch(out, /HTTP|DOMException|queued \(|\bat \w+ \(|invoking|kaboom/, `${r} -> ${out}`);
    }
  }
});
