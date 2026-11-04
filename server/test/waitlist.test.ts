// Streamer waitlist: form validation, dedupe, the admin gate, and the
// approve → single-use invite transition (Discord faked via the minter seam).
// Same scratch-DB setup as auth.test.ts (see test/env.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { addSignup, listSignups, parseSignup, setInviteMinterForTests, waitlistRouter } from "../src/waitlist.js";

const ADMIN = `Bearer ${"a".repeat(40)}`;
const VALID = { email: " Streamer@Example.com ", channel: "twitch.tv/someone", viewers: "10-50", idea: "make me a muppet" };

async function serve() {
  const app = express();
  app.use(express.json());
  app.use(waitlistRouter());
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  return { call, close: () => server.close() };
}

test("parseSignup: normalizes the email and rejects each missing field", () => {
  const ok = parseSignup(VALID);
  assert.ok(ok.ok);
  assert.equal(ok.value.email, "streamer@example.com");
  assert.equal(parseSignup({ ...VALID, email: "nope" }).ok, false);
  assert.equal(parseSignup({ ...VALID, channel: "" }).ok, false);
  assert.equal(parseSignup({ ...VALID, viewers: "a million" }).ok, false);
  assert.equal(parseSignup(null).ok, false);
});

test("addSignup: a repeat email is a silent no-op", () => {
  const v = { ...VALID, email: "dupe@example.com", viewers: "under-10" as const };
  assert.deepEqual(addSignup(v, "1.2.3.4"), { created: true });
  assert.deepEqual(addSignup({ ...v, channel: "other" }, "1.2.3.4"), { created: false });
  assert.equal(listSignups().filter((s) => s.email === "dupe@example.com").length, 1);
});

test("POST /api/waitlist: stores a signup, CORS only for site origins, honeypot fakes success", async () => {
  const { call, close } = await serve();
  try {
    const res = await call("/api/waitlist", {
      method: "POST",
      headers: { Origin: "https://streamhijack.com" },
      body: JSON.stringify({ ...VALID, email: "http@example.com" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://streamhijack.com");
    assert.ok(listSignups("pending").some((s) => s.email === "http@example.com"));

    const evil = await call("/api/waitlist", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);

    const bad = await call("/api/waitlist", { method: "POST", body: JSON.stringify({ ...VALID, email: "x" }) });
    assert.equal(bad.status, 400);

    const bot = await call("/api/waitlist", {
      method: "POST",
      body: JSON.stringify({ ...VALID, email: "bot@example.com", website: "spam.biz" }),
    });
    assert.equal(bot.status, 200);
    assert.ok(!listSignups().some((s) => s.email === "bot@example.com"), "honeypot hit is not stored");
  } finally {
    close();
  }
});

test("admin: token required; invite mints once, re-invite returns the same link; decline is pending-only", async () => {
  const { call, close } = await serve();
  let minted = 0;
  setInviteMinterForTests(async () => `https://discord.gg/test${++minted}`);
  try {
    assert.equal((await call("/api/admin/waitlist")).status, 401);
    assert.equal((await call("/api/admin/waitlist", { headers: { Authorization: "Bearer wrong" } })).status, 401);

    addSignup({ ...VALID, email: "approve@example.com", viewers: "50-200" }, "5.6.7.8");
    const list = (await (await call("/api/admin/waitlist?status=pending", { headers: { Authorization: ADMIN } })).json()) as {
      signups: { id: string; email: string }[];
    };
    const id = list.signups.find((s) => s.email === "approve@example.com")!.id;

    const first = (await (await call(`/api/admin/waitlist/${id}/invite`, { method: "POST", headers: { Authorization: ADMIN } })).json()) as { status: string; inviteUrl: string };
    assert.equal(first.status, "invited");
    assert.equal(first.inviteUrl, "https://discord.gg/test1");
    const again = (await (await call(`/api/admin/waitlist/${id}/invite`, { method: "POST", headers: { Authorization: ADMIN } })).json()) as { inviteUrl: string };
    assert.equal(again.inviteUrl, "https://discord.gg/test1");
    assert.equal(minted, 1, "re-inviting never mints a second invite");

    const decline = await call(`/api/admin/waitlist/${id}/decline`, { method: "POST", headers: { Authorization: ADMIN } });
    assert.equal(decline.status, 409, "an invited signup can't be declined");
    assert.equal((await call(`/api/admin/waitlist/nope/invite`, { method: "POST", headers: { Authorization: ADMIN } })).status, 404);
  } finally {
    setInviteMinterForTests(null);
    close();
  }
});

test("admin: approving without Discord configured answers 503 and leaves the signup pending", async () => {
  const { call, close } = await serve();
  try {
    addSignup({ ...VALID, email: "nodiscord@example.com", viewers: "200-plus" }, "9.9.9.9");
    const id = listSignups("pending").find((s) => s.email === "nodiscord@example.com")!.id;
    const res = await call(`/api/admin/waitlist/${id}/invite`, { method: "POST", headers: { Authorization: ADMIN } });
    assert.equal(res.status, 503);
    assert.equal(listSignups("pending").some((s) => s.id === id), true);
  } finally {
    close();
  }
});
