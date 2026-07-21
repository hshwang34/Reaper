// Persistence: Drizzle over better-sqlite3.
//
// SQLite is a deliberate alpha choice, not a shortcut: the control plane runs
// as ONE machine with in-memory per-channel engines (no sticky routing, no
// horizontal scale until post-alpha), so a local file DB removes an entire
// managed dependency. Drizzle keeps the schema portable — the Neon/Postgres
// swap at scale is a dialect change, not a rewrite. DDL is bootstrapped
// inline (CREATE TABLE IF NOT EXISTS) instead of drizzle-kit migrations —
// revisit when the schema starts moving under real users.

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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

// ── Bootstrap ─────────────────────────────────────────────────────────────

const sqlite = new Database(env.databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
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
CREATE INDEX IF NOT EXISTS idx_hijacks_channel ON hijacks(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mints_channel ON token_mints(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refresh_channel ON refresh_tokens(channel_id);
`);

export const db = drizzle(sqlite);
