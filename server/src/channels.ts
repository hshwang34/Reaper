// Per-channel runtime: the SAME @rh/core money path the demo rig runs, one
// instance per streamer, lazily created and held in memory (single-machine
// alpha — see db.ts). Each runtime is a core `createRuntime` plus what only
// the hosted plane has: a persistent ledger (hijack rows, token mints, the
// monthly GPU cap) and the channel's trigger credentials.
//
// The mint path is the money-critical seam. Policy lives in core
// (`gatedMint`: job-gated, one per job, budget-capped, debit-after-success);
// this file supplies the SQLite-backed ledger it reads and writes. Enforced
// here, server-side, because the client is the streamer's machine and the
// key is ours.
//
// Lifecycle: a runtime lives as long as the process unless the channel is
// suspended or explicitly stopped. Trigger credentials are swapped IN PLACE
// (`setStreamlabsToken`) — rebuilding the runtime would orphan the router
// socket the front door already adopted into the old hub.

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  HOSTED_SETTINGS,
  loadSettings,
  type ModerationEvent,
  type Settings,
  type TipEvent,
} from "@rh/shared";
import {
  createRuntime,
  createStreamlabsAdapter,
  gatedMint,
  log,
  mintClientToken,
  moderationFromEnv,
  warn,
  type MintLedger,
  type ModerationSuite,
  type Runtime,
  type SafetyLedger,
  type TriggerAdapter,
} from "@rh/core";
import { channels, db, hijacks, moderationEvents, takedownContacts, tokenMints } from "./db.js";
import { env } from "./env.js";

/** One classifier suite for every channel — it holds OUR vendor keys and is
 *  stateless; per-channel policy is passed on each call. Dev mode only when
 *  the plane has no Decart key (every token mints as MOCK). */
let suite: ModerationSuite | null = null;
function moderationSuite(): ModerationSuite {
  suite ??= moderationFromEnv(process.env, !env.decartApiKey);
  return suite;
}

/** The channel's moderation ledger, in SQLite. */
function dbSafetyLedger(channelId: string): SafetyLedger {
  return {
    record(e) {
      const ev: ModerationEvent = { id: randomUUID(), ts: Date.now(), ...e };
      db.insert(moderationEvents)
        .values({
          id: ev.id,
          channelId,
          ts: ev.ts,
          stage: ev.stage,
          verdict: ev.verdict,
          source: ev.source,
          reason: ev.reason.slice(0, 1000),
          categoriesJson: JSON.stringify(ev.categories),
          code: ev.code ?? null,
          jobId: ev.jobId ?? null,
          inputHash: ev.inputHash ?? null,
          ipHash: ev.ipHash ?? null,
          tipper: ev.tipper ?? null,
        })
        .run();
      return ev;
    },
    recordContact(ticket, contact) {
      db.insert(takedownContacts)
        .values({ ticket, channelId, contact: contact.slice(0, 200), ts: Date.now() })
        .run();
    },
    recent(limit = 100) {
      return db
        .select()
        .from(moderationEvents)
        .where(eq(moderationEvents.channelId, channelId))
        .orderBy(desc(moderationEvents.ts))
        .limit(limit)
        .all()
        .map((r) => ({
          id: r.id,
          ts: r.ts,
          stage: r.stage as ModerationEvent["stage"],
          verdict: r.verdict as ModerationEvent["verdict"],
          source: r.source,
          reason: r.reason,
          categories: JSON.parse(r.categoriesJson) as string[],
          code: r.code,
          jobId: r.jobId,
          inputHash: r.inputHash,
          ipHash: r.ipHash,
          tipper: r.tipper,
        }));
    },
  };
}

export interface ChannelRuntime extends Runtime {
  channelId: string;
  updateSettings(patch: Partial<Settings>): Settings;
  onTip(tip: TipEvent): string;
  /** Job-gated, one-per-job, budget-capped ek_ mint. Throws MintError. */
  mint(durationSec: number): Promise<string>;
  /** Swap the Streamlabs credential without tearing the runtime down. */
  setStreamlabsToken(token: string): void;
  /** Tear everything down: triggers, engine timers, sockets. */
  stop(): void;
}

const runtimes = new Map<string, ChannelRuntime>();

export function channelExists(channelId: string): boolean {
  return Boolean(
    db.select().from(channels).where(eq(channels.id, channelId)).get(),
  );
}

/** The month-to-date GPU ledger for one channel, read from the audit table
 *  (not a counter that can drift). */
function dbLedger(channelId: string, capSec: number): MintLedger {
  const monthStart = () => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  };
  return {
    hasMintFor: (jobId) =>
      Boolean(
        db.select({ id: tokenMints.id }).from(tokenMints).where(eq(tokenMints.jobId, jobId)).get(),
      ),
    usedSec: () =>
      db
        .select({ total: sql<number>`coalesce(sum(capped_sec), 0)` })
        .from(tokenMints)
        .where(and(eq(tokenMints.channelId, channelId), gte(tokenMints.createdAt, monthStart())))
        .get()?.total ?? 0,
    capSec: () => capSec,
    record: ({ jobId, durationSec, cappedSec }) => {
      db.insert(tokenMints)
        .values({ channelId, jobId, durationSec, cappedSec, createdAt: Date.now() })
        .run();
    },
  };
}

export function getRuntime(channelId: string): ChannelRuntime | null {
  const row = db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();
  // Suspension is checked on EVERY lookup, not just cold creation: a channel
  // suspended mid-stream must stop minting now, not at the next restart.
  const existing = runtimes.get(channelId);
  if (!row || row.suspended) {
    existing?.stop();
    return null;
  }
  if (existing) return existing;

  const tag = `engine:${row.login}`;

  const getSettings = (): Settings => {
    const fresh = db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();
    // HOSTED_SETTINGS, not the local defaults: our key, our uploads, our
    // liability — a new channel starts presets-only (CONTENT-SAFETY §5).
    try {
      return loadSettings(JSON.parse(fresh?.settingsJson ?? "{}"), HOSTED_SETTINGS);
    } catch {
      return { ...HOSTED_SETTINGS };
    }
  };

  const core = createRuntime({
    getSettings,
    server: null, // adopted mode — the front door owns the WebSocketServer
    // Local-plane traffic (rtc:*, frames-ok) never traverses the cloud —
    // the Electron bridge relays it on the streamer's machine.
    hub: { rejectLocalPlane: true },
    tag,
    hooks: {
      // Ledger: one row per dispatched job, updated on completion.
      onDispatch: (job) => {
        db.insert(hijacks)
          .values({
            channelId,
            jobId: job.jobId,
            source: job.tip.source,
            username: job.tip.username,
            amountUsd: job.tip.amount,
            durationSec: job.durationSec,
            prompt: job.prompt.slice(0, 300),
            createdAt: Date.now(),
          })
          .run();
      },
      onJobDone: (jobId, ok, reason) => {
        db.update(hijacks)
          .set({ outcome: ok ? "completed" : "failed", reason: reason ?? null })
          .where(eq(hijacks.jobId, jobId))
          .run();
      },
    },
    safety: { moderation: moderationSuite(), ledger: dbSafetyLedger(channelId) },
  });
  const ledger = dbLedger(channelId, row.monthlyGpuSecondsCap);

  // ── Triggers ────────────────────────────────────────────────────────────
  let streamlabs: TriggerAdapter | null = null;
  const startStreamlabs = (token: string) => {
    streamlabs?.stop();
    streamlabs = null;
    if (!token) return;
    const sl = createStreamlabsAdapter(token);
    sl.start((tip) => {
      const outcome = core.engine.onTip(tip);
      log(tag, `streamlabs $${tip.amount} from ${tip.username} → ${outcome}`);
    });
    streamlabs = sl;
  };
  startStreamlabs(row.streamlabsToken ?? "");

  const runtime: ChannelRuntime = {
    ...core,
    channelId,
    updateSettings(patch) {
      const next = { ...getSettings(), ...patch };
      db.update(channels)
        .set({ settingsJson: JSON.stringify(next) })
        .where(eq(channels.id, channelId))
        .run();
      return next;
    },
    onTip: (tip) => core.engine.onTip(tip),
    mint: (durationSec) =>
      gatedMint(
        core.engine,
        durationSec,
        (d) => mintClientToken(env.decartApiKey, d, ""),
        ledger,
      ),
    setStreamlabsToken(token: string) {
      db.update(channels)
        .set({ streamlabsToken: token })
        .where(eq(channels.id, channelId))
        .run();
      startStreamlabs(token);
      log(tag, token ? "streamlabs trigger (re)connected" : "streamlabs trigger removed");
    },
    stop() {
      streamlabs?.stop();
      streamlabs = null;
      core.dispose("channel runtime stopped"); // cancels the active job via the hub
      runtimes.delete(channelId);
      log(tag, "runtime stopped");
    },
  };
  if (!env.decartApiKey) warn(tag, "no Decart key — tokens mint as MOCK");

  runtimes.set(channelId, runtime);
  log(tag, "runtime created");
  return runtime;
}
