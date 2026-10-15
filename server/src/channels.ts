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

import { and, eq, gte, sql } from "drizzle-orm";
import { DEFAULT_SETTINGS, loadSettings, type Settings, type TipEvent } from "@rh/shared";
import {
  createRuntime,
  createStreamlabsAdapter,
  gatedMint,
  log,
  mintClientToken,
  warn,
  type MintLedger,
  type Runtime,
  type TriggerAdapter,
} from "@rh/core";
import { channels, db, hijacks, tokenMints } from "./db.js";
import { env } from "./env.js";

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
  const existing = runtimes.get(channelId);
  if (existing) return existing;

  const row = db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();
  if (!row || row.suspended) return null;

  const tag = `engine:${row.login}`;

  const getSettings = (): Settings => {
    const fresh = db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();
    try {
      return loadSettings(JSON.parse(fresh?.settingsJson ?? "{}"));
    } catch {
      return { ...DEFAULT_SETTINGS };
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
