// Persistence: Drizzle over better-sqlite3.
//
// SQLite is a deliberate alpha choice, not a shortcut: the control plane runs
// as ONE machine with in-memory per-channel engines (no sticky routing, no
// horizontal scale until post-alpha), so a local file DB removes an entire
// managed dependency. Drizzle keeps the schema portable — the Neon/Postgres
// swap at scale is a dialect change, not a rewrite. DDL is applied by a
// tiny versioned migrator (below) rather than drizzle-kit: one file, no
// generated artifacts, and it runs at boot on the production volume.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { log, warn } from "@rh/core";
import { env } from "./env.js";

// ── Schema ────────────────────────────────────────────────────────────────

/** One row per streamer channel. `id` is the Twitch user id (or dev:<login>
 *  under dev auth). `settings` is the same shape as @rh/shared Settings. */
export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  login: text("login").notNull().unique(),
  displayName: text("display_name").notNull(),
  settingsJson: text("settings_json").notNull().default("{}"),
  /** Streamlabs Socket API token (pasted; OAuth connect replaces this once
   *  the Streamlabs app is approved). TODO(beta): encrypt at rest. */
  streamlabsToken: text("streamlabs_token").notNull().default(""),
  monthlyGpuSecondsCap: integer("monthly_gpu_seconds_cap")
    .notNull()
    .default(env.monthlyGpuSecondsCap),
  suspended: integer("suspended").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  /** Stripe Connect (Express) account that receives the streamer's share. */
  stripeAccountId: text("stripe_account_id"),
  /** Mirrors the account's `transfers` capability: until Stripe has verified
   *  the streamer, the portal can't take payments for this channel. */
  payoutsEnabled: integer("payouts_enabled").notNull().default(0),
});

/** Rotating refresh tokens (hashed — a DB leak must not mint sessions). */
export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** The per-hijack ledger — FEASIBILITY calls this the #1 support surface.
 *  One row per dispatched job: tip → duration → outcome. */
export const hijacks = sqliteTable("hijacks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: text("channel_id").notNull(),
  jobId: text("job_id").notNull(),
  source: text("source").notNull(),
  username: text("username").notNull(),
  amountUsd: real("amount_usd").notNull(),
  durationSec: integer("duration_sec").notNull(),
  prompt: text("prompt").notNull(),
  outcome: text("outcome").notNull().default("dispatched"),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
});

/** Every minted ek_ token: the cost-audit trail + the monthly-cap counter. */
export const tokenMints = sqliteTable("token_mints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: text("channel_id").notNull(),
  jobId: text("job_id"),
  durationSec: integer("duration_sec").notNull(),
  cappedSec: integer("capped_sec").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** Submission log (analytics/debug; the live pending set is in-memory). */
export const submissionsLog = sqliteTable("submissions_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: text("channel_id").notNull(),
  code: text("code").notNull(),
  presetId: text("preset_id"),
  hasImage: integer("has_image").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

/** The moderation ledger (docs/CONTENT-SAFETY.md S5): every text/image
 *  verdict, review decision, output-guard stop, viewer report and takedown.
 *  Hashes only — never the moderated bytes or a raw IP. Same shape as
 *  @rh/shared ModerationEvent; `categories` is a JSON array. */
export const moderationEvents = sqliteTable("moderation_events", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  ts: integer("ts").notNull(),
  stage: text("stage").notNull(),
  verdict: text("verdict").notNull(),
  source: text("source").notNull(),
  reason: text("reason").notNull(),
  categoriesJson: text("categories_json").notNull().default("[]"),
  code: text("code"),
  jobId: text("job_id"),
  inputHash: text("input_hash"),
  ipHash: text("ip_hash"),
  tipper: text("tipper"),
});

/** One row per viewer payment (Stripe Checkout). The money record: what was
 *  paid, what we kept (application fee = Stripe fee + GPU + margin), and how
 *  it settled. Status: pending → paid → delivered | refunded | refund_failed
 *  (pending rows that never complete are abandoned checkouts). */
export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  checkoutSessionId: text("checkout_session_id").notNull().unique(),
  paymentIntentId: text("payment_intent_id"),
  code: text("code").notNull(),
  amountCents: integer("amount_cents").notNull(),
  applicationFeeCents: integer("application_fee_cents").notNull(),
  gpuCents: integer("gpu_cents").notNull(),
  durationSec: integer("duration_sec").notNull(),
  viewerName: text("viewer_name").notNull(),
  jobId: text("job_id"),
  status: text("status").notNull(),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Stripe event ids already handled — webhooks are at-least-once, and a
 *  replayed checkout.session.completed must never run a second hijack. */
export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: integer("received_at").notNull(),
});

// ── Bootstrap + migrations ────────────────────────────────────────────────
// Versioned with SQLite's own `PRAGMA user_version`: migration N runs once,
// in order, inside a transaction, and bumps the version. Append new steps;
// never edit a shipped one (it has already run on the production volume).
// Migration 1 is the original schema, written with IF NOT EXISTS so a
// database created before versioning (user_version 0) adopts it cleanly.

const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  streamlabs_token TEXT NOT NULL DEFAULT '',
  monthly_gpu_seconds_cap INTEGER NOT NULL DEFAULT ${env.monthlyGpuSecondsCap},
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hijacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  source TEXT NOT NULL,
  username TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  duration_sec INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'dispatched',
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_mints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  job_id TEXT,
  duration_sec INTEGER NOT NULL,
  capped_sec INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  code TEXT NOT NULL,
  preset_id TEXT,
  has_image INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moderation_events (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  stage TEXT NOT NULL,
  verdict TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  code TEXT,
  job_id TEXT,
  input_hash TEXT,
  ip_hash TEXT,
  tipper TEXT
);
CREATE INDEX IF NOT EXISTS idx_moderation_channel ON moderation_events(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_hijacks_channel ON hijacks(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mints_channel ON token_mints(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refresh_channel ON refresh_tokens(channel_id);
`,
  /* 2 — viewer payments (Stripe Connect) */ `
ALTER TABLE channels ADD COLUMN stripe_account_id TEXT;
ALTER TABLE channels ADD COLUMN payouts_enabled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  checkout_session_id TEXT NOT NULL UNIQUE,
  payment_intent_id TEXT,
  code TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  application_fee_cents INTEGER NOT NULL,
  gpu_cents INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  viewer_name TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_channel ON payments(channel_id, created_at);
CREATE INDEX idx_payments_status ON payments(status);
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`,
];

/** Apply pending migrations to `conn`; returns the resulting version. */
export function migrate(conn: Database.Database, steps = MIGRATIONS): number {
  let version = conn.pragma("user_version", { simple: true }) as number;
  for (; version < steps.length; version++) {
    const sql = steps[version];
    const next = version + 1;
    conn.transaction(() => {
      conn.exec(sql);
      conn.pragma(`user_version = ${next}`);
    })();
    log("db", `migrated to schema v${next}`);
  }
  return version;
}

const sqlite = new Database(env.databasePath);
sqlite.pragma("journal_mode = WAL");
migrate(sqlite);

export const db = drizzle(sqlite);

/** Online snapshot (better-sqlite3's backup API — consistent under WAL
 *  while the server keeps writing). Keeps the newest 7. */
export async function backupDatabase(): Promise<string | null> {
  try {
    mkdirSync(env.backupDir, { recursive: true });
    const file = resolve(env.backupDir, `data-${new Date().toISOString().slice(0, 10)}.sqlite`);
    await sqlite.backup(file);
    const old = readdirSync(env.backupDir)
      .filter((f) => /^data-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
      .sort()
      .slice(0, -7);
    for (const f of old) rmSync(resolve(env.backupDir, f), { force: true });
    log("db", `backup → ${file}`);
    return file;
  } catch (e) {
    warn("db", `backup failed: ${(e as Error).message}`);
    return null;
  }
}
