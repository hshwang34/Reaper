// The hosted streamer gate (requireChannel) and runtime suspension.
// Same scratch-DB setup as auth.test.ts (see its header).

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { issueSession, requireChannel, upsertChannel } from "../src/auth.js";
import { getRuntime } from "../src/channels.js";
import { db, channels } from "../src/db.js";

/** Run requireChannel against a fake req/res; report status or "next". */
async function gate(param: string, token: string | null) {
  let status = 0;
  let passed = false;
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) {
      status = code;
      return { json: () => undefined };
    },
  };
  const req = {
    params: { channel: param },
    header: (h: string) => (h === "authorization" && token ? `Bearer ${token}` : undefined),
  };
  await requireChannel(req as never, res as never, () => {
    passed = true;
  });
  return { outcome: passed ? "next" : status, channelId: res.locals.channelId };
}

test("requireChannel accepts the id or the login, resolves to the id", async () => {
  upsertChannel("dev:gate", "GateUser", "Gate User");
  const { access } = await issueSession("dev:gate", "gateuser");
  assert.deepEqual(await gate("dev:gate", access), { outcome: "next", channelId: "dev:gate" });
  assert.deepEqual(await gate("gateuser", access), { outcome: "next", channelId: "dev:gate" });
  assert.deepEqual(await gate("GateUser", access), { outcome: "next", channelId: "dev:gate" });
});

test("requireChannel: no/bad token is 401, someone else's channel is 403", async () => {
  upsertChannel("dev:other", "other", "Other");
  const { access } = await issueSession("dev:gate", "gateuser");
  assert.equal((await gate("dev:gate", null)).outcome, 401);
  assert.equal((await gate("dev:gate", "garbage")).outcome, 401);
  assert.equal((await gate("dev:other", access)).outcome, 403);
  assert.equal((await gate("other", access)).outcome, 403);
});

test("suspending a channel stops its already-running runtime", () => {
  upsertChannel("dev:susp", "susp", "Susp");
  const rt = getRuntime("dev:susp");
  assert.ok(rt, "runtime created");
  assert.equal(getRuntime("dev:susp"), rt, "cached while active");
  db.update(channels).set({ suspended: 1 }).where(eq(channels.id, "dev:susp")).run();
  assert.equal(getRuntime("dev:susp"), null, "suspension seen on the warm path");
  db.update(channels).set({ suspended: 0 }).where(eq(channels.id, "dev:susp")).run();
  const fresh = getRuntime("dev:susp");
  assert.ok(fresh && fresh !== rt, "unsuspend builds a fresh runtime");
  fresh.stop();
});
