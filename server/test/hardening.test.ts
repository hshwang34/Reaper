// Production hardening: the boot gate, the schema migrator, and the free
// daily test-hijack allowance (the only GPU time not funded by a viewer).
// Same scratch-DB setup as auth.test.ts (see its header).

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { upsertChannel } from "../src/auth.js";
import { getRuntime, TEST_HIJACK_SEC } from "../src/channels.js";
import { migrate } from "../src/db.js";
import { productionProblems } from "../src/env.js";

const FULL = {
  RH_PUBLIC_URL: "https://reality-hijack.fly.dev",
  RH_JWT_SECRET: "x".repeat(64),
  DECART_API_KEY: "dct_x",
  TWITCH_CLIENT_ID: "id",
  TWITCH_CLIENT_SECRET: "secret",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
};

test("production boot gate: a complete config passes", () => {
  assert.deepEqual(productionProblems(FULL), []);
});

test("production boot gate: lists every problem at once", () => {
  const p = productionProblems({ ...FULL, TWITCH_CLIENT_ID: "", DECART_API_KEY: " ", RH_JWT_SECRET: "short" });
  assert.equal(p.length, 3);
  assert.ok(p.some((x) => x.startsWith("TWITCH_CLIENT_ID")));
  assert.ok(p.some((x) => x.startsWith("DECART_API_KEY")), "whitespace-only counts as missing");
  assert.ok(p.some((x) => x.startsWith("RH_JWT_SECRET")));
});

test("production boot gate: the public URL must be https", () => {
  assert.deepEqual(productionProblems({ ...FULL, RH_PUBLIC_URL: "http://example.com" }), [
    "RH_PUBLIC_URL must be https:// in production",
  ]);
});

test("migrate: runs each step once, in order, and is idempotent", () => {
  const conn = new Database(":memory:");
  const steps = ["CREATE TABLE a (x INTEGER);", "ALTER TABLE a ADD COLUMN y INTEGER;"];
  assert.equal(migrate(conn, steps), 2);
  assert.equal(migrate(conn, steps), 2, "second run is a no-op");
  const cols = conn.prepare("PRAGMA table_info(a)").all() as { name: string }[];
  assert.deepEqual(cols.map((c) => c.name), ["x", "y"]);
  // A later deploy appends a step: only the new one runs.
  assert.equal(migrate(conn, [...steps, "CREATE TABLE b (z INTEGER);"]), 3);
});

test("migrate: a failing step rolls back and leaves the version unchanged", () => {
  const conn = new Database(":memory:");
  assert.throws(() => migrate(conn, ["CREATE TABLE a (x INTEGER); NOT SQL;"]));
  assert.equal(conn.pragma("user_version", { simple: true }), 0);
  assert.equal(conn.prepare("SELECT name FROM sqlite_master WHERE name='a'").get(), undefined);
});

test("free test hijack: one per channel per day, fixed duration, then 429", () => {
  upsertChannel("dev:tester", "tester", "Tester");
  const rt = getRuntime("dev:tester")!;
  const first = rt.testHijack();
  assert.equal(first.ok, true);
  const second = rt.testHijack();
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.status, 429);
  assert.equal(TEST_HIJACK_SEC, 10);
  // Allowances are per channel, not global.
  upsertChannel("dev:tester2", "tester2", "Tester 2");
  assert.equal(getRuntime("dev:tester2")!.testHijack().ok, true);
  rt.stop();
  getRuntime("dev:tester2")?.stop();
});

test("production boot gate: refuses the e2e test seams", () => {
  const p = productionProblems({
    ...FULL,
    STRIPE_API_BASE: "http://127.0.0.1:1",
    RH_OFFLINE_GRACE_MS: "1000",
    RH_FREE_TESTS_PER_DAY: "5",
  });
  assert.equal(p.length, 3);
  assert.ok(p.every((x) => x.includes("test seam")));
});
