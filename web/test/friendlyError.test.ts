// friendlyError: raw network/server text never reaches a viewer (BRAND §5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK, friendlyError } from "../src/lib/friendlyError.js";

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
  assert.match(friendlyError(withStatus("boom", 413)), /too large/);
  assert.equal(friendlyError(withStatus("kaboom", 502)), FALLBACK);
  assert.equal(friendlyError("DecartError: token mint failed"), FALLBACK);
  assert.equal(friendlyError(undefined), FALLBACK);
});

test("no vendor or jargon leaks through the fallback", () => {
  assert.doesNotMatch(FALLBACK, /decart|token|mint|http/i);
});
