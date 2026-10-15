// Hosted auth helpers: one-time exchange codes + constant-time compare.
// Importing auth.ts opens the SQLite database (db.ts has import-time side
// effects), so the npm script points RH_DATABASE_PATH at a scratch file
// before importing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { issueExchangeCode, redeemExchangeCode, safeEqual, type SessionTokens } from "../src/auth.js";

const tokens: SessionTokens = {
  access: "a",
  refresh: "r",
  channelId: "dev:test",
  login: "test",
};

test("an exchange code redeems exactly once", () => {
  const code = issueExchangeCode(tokens);
  assert.match(code, /^[A-Za-z0-9_-]{20,}$/, "opaque, URL-safe");
  assert.deepEqual(redeemExchangeCode(code), tokens);
  assert.equal(redeemExchangeCode(code), null, "second redemption is refused");
});

test("unknown and malformed codes are refused", () => {
  assert.equal(redeemExchangeCode(""), null);
  assert.equal(redeemExchangeCode("not-a-real-code"), null);
});

test("codes are unique per issue", () => {
  const a = issueExchangeCode(tokens);
  const b = issueExchangeCode(tokens);
  assert.notEqual(a, b);
});

test("safeEqual: equal strings match, unequal and different-length do not", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});
