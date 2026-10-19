// Accountability (CONTENT-SAFETY S5): every moderation decision is a record —
// the streamer's appeal trail, the evidence in a platform dispute, and the
// paper trail for a takedown or a CyberTipline report. Records carry hashes,
// never the moderated bytes or raw IPs.
//
// Hosts pick the store: the hosted plane writes SQLite (server/src/db.ts),
// the local rig and the Electron app append JSONL next to their settings.
// Also here: the per-submitter strike tracker and a tiny fixed-window rate
// limiter for the public safety endpoints.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ModerationEvent } from "@rh/shared";
import { warn } from "./log.js";

export type ModerationEventInput = Omit<ModerationEvent, "id" | "ts">;

export interface SafetyLedger {
  record(e: ModerationEventInput): ModerationEvent;
  /** Newest first. This is what the STREAMER sees (/moderation). */
  recent(limit?: number): ModerationEvent[];
  /**
   * Operator-only: the takedown requester's contact, keyed by ticket id.
   * Kept out of `record`/`recent` on purpose — the person asking for an image
   * of themselves to be removed must not be identified to the streamer (who
   * may be the one who put it on stream). Never returned by any API route.
   */
  recordContact(ticket: string, contact: string): void;
}

function stamp(e: ModerationEventInput): ModerationEvent {
  return { id: randomUUID(), ts: Date.now(), ...e };
}

/** Bounded in-memory ledger (tests; and the tail behind the JSONL one).
 *  `seed` pre-loads already-stamped events, oldest first. */
export function memorySafetyLedger(cap = 500, seed: ModerationEvent[] = []): SafetyLedger {
  const ring: ModerationEvent[] = seed.slice(-cap);
  const contacts = new Map<string, string>();
  return {
    record(e) {
      const ev = stamp(e);
      ring.push(ev);
      if (ring.length > cap) ring.splice(0, ring.length - cap);
      return ev;
    },
    recent: (limit = 100) => ring.slice(-limit).reverse(),
    recordContact: (ticket, contact) => void contacts.set(ticket, contact),
  };
}

/** Append-only JSONL on disk + an in-memory tail for the dashboard view.
 *  Takedown contacts go to a separate owner-only file next to it
 *  (`<name>.contacts.jsonl`) that no route reads. */
export function jsonlSafetyLedger(path: string, cap = 500): SafetyLedger {
  const contactsPath = path.replace(/\.jsonl$/, "") + ".contacts.jsonl";
  const seed: ModerationEvent[] = [];
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n").slice(-cap - 1)) {
        if (line.trim()) seed.push(JSON.parse(line) as ModerationEvent);
      }
    } catch (e) {
      warn("safety", `could not read ${path}: ${(e as Error).message}`);
    }
  }
  const mem = memorySafetyLedger(cap, seed);
  return {
    record(e) {
      const ev = mem.record(e);
      try {
        appendFileSync(path, `${JSON.stringify(ev)}\n`, { mode: 0o600 });
      } catch (err) {
        warn("safety", `ledger append failed: ${(err as Error).message}`);
      }
      return ev;
    },
    recent: (limit) => mem.recent(limit),
    recordContact(ticket, contact) {
      try {
        appendFileSync(contactsPath, `${JSON.stringify({ ticket, contact, ts: Date.now() })}\n`, {
          mode: 0o600,
        });
      } catch (err) {
        warn("safety", `takedown contact append failed: ${(err as Error).message}`);
      }
    },
  };
}

// ── Identity without storing identity ────────────────────────────────────

const SALT = randomBytes(16);

/** Salted, truncated IP hash. Per-process salt: good enough to rate-limit
 *  and strike within a run, useless to anyone reading the ledger later. */
export function ipHash(ip: string | undefined | null): string {
  return createHash("sha256")
    .update(SALT)
    .update(ip ?? "unknown")
    .digest("hex")
    .slice(0, 16);
}

/**
 * The submitter identity for strikes and rate limits: salted hash of
 * (channel, client IP). Channel-scoped so one channel's abuser can't spend
 * another channel's budget (the hosted plane mounts ONE router for all).
 *
 * `ip` must be the real client address. Behind a reverse proxy (Fly) that
 * means the host sets Express `trust proxy` to the proxy hop count —
 * otherwise every viewer is the proxy, shares one key, and one troll's
 * strikes would hit everyone. Hosts own that setting (server/src/env.ts).
 */
export function clientKey(channel: string | undefined, ip: string | undefined | null): string {
  return ipHash(`${channel ?? ""}|${ip ?? "unknown"}`);
}

// ── Strikes ──────────────────────────────────────────────────────────────

/** N rejected submissions within the window → that submitter is blocked for
 *  the window. Keeps a troll from brute-forcing the classifier. */
export class StrikeTracker {
  private hits = new Map<string, number[]>();
  constructor(
    private limit = 3,
    private windowMs = 60 * 60 * 1000,
  ) {}

  strike(key: string): void {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
  }

  blocked(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, list);
    return list.length >= this.limit;
  }
}

/** Fixed-window limiter for the public report/takedown endpoints. */
export class RateLimiter {
  private windows = new Map<string, { start: number; n: number }>();
  constructor(
    private max = 10,
    private windowMs = 60_000,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, n: 1 });
      return true;
    }
    w.n += 1;
    return w.n <= this.max;
  }
}
