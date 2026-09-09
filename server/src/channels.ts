// Per-channel runtime: the SAME @rh/core money path the demo rig runs, one
// instance per streamer, lazily created and held in memory (single-machine
// alpha — see db.ts). Each runtime owns:
//   · Engine + CorrelationStore (tip→job→queue)
//   · an adopted-mode Hub (the front door in index.ts routes sockets here)
//   · the channel's trigger adapters (Streamlabs socket per pasted token)
//   · ledger hooks (hijacks/token_mints rows) + the monthly GPU mint cap
//
// The mint path is the money-critical seam: job-gated (only an active
// dispatched job for this channel can mint, and only ONCE per job) and capped
// (sum of this month's capped seconds must stay under the channel's budget)
// — both enforced HERE, server-side, because the client is the streamer's
// machine and the key is ours.
//
// Lifecycle: a runtime lives as long as the process unless the channel is
// suspended or explicitly stopped. Trigger credentials are swapped IN PLACE
// (`setStreamlabsToken`) — rebuilding the runtime would orphan the router
// socket the front door already adopted into the old hub.

import { and, eq, gte, sql } from "drizzle-orm";
import { DEFAULT_SETTINGS, type Settings, type TipEvent } from "@rh/shared";
import {
  CorrelationStore,
  Engine,
  Hub,
  SESSION_CAP_EXTRA_SEC,
  createStreamlabsAdapter,
  log,
  mintClientToken,
  warn,
  type EngineEmit,
  type TriggerAdapter,
} from "@rh/core";
import { channels, db, hijacks, tokenMints } from "./db.js";
import { env } from "./env.js";

export interface ChannelRuntime {
  channelId: string;
  engine: Engine;
  hub: Hub;
  correlation: CorrelationStore;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  onTip(tip: TipEvent): string;
  /** Job-gated, budget-capped ek_ mint. Throws with a user-facing message. */
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
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fresh?.settingsJson ?? "{}") };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  };

  // Engine ↔ Hub wiring, same late-bind pattern as the local composition.
  let hub: Hub;
  const correlation = new CorrelationStore();
  const emit: EngineEmit = {
    dispatchJob: (job) => {
      // Ledger: one row per dispatched job, updated on completion.
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
      hub.dispatchJob(job);
    },
    cancelJob: (jobId, reason) => hub.cancelJob(jobId, reason),
    status: (snap) => hub.broadcastStatus(snap),
    submissionUpdate: (code, status) => hub.sendSubmissionUpdate(code, status),
  };
  const engine = new Engine(correlation, emit, getSettings);

  hub = new Hub(
    null, // adopted mode — the front door owns the WebSocketServer
    {
      onRouterState: (state, jobId, rem) =>
        engine.setRouterState(state, jobId, rem),
      onJobDone: (jobId, ok, reason) => {
        db.update(hijacks)
          .set({ outcome: ok ? "completed" : "failed", reason: reason ?? null })
          .where(eq(hijacks.jobId, jobId))
          .run();
        engine.onJobDone(jobId, ok, reason);
      },
      onRouterDisconnected: () => {
        warn(tag, "router (app link) disconnected");
        engine.setRouterState("OFFLINE");
      },
      getStatus: () => engine.snapshot(),
    },
    // Local-plane traffic (rtc:*, frames-ok) never traverses the cloud —
    // the Electron bridge relays it on the streamer's machine.
    { rejectLocalPlane: true },
  );

  // ── Triggers ────────────────────────────────────────────────────────────
  let streamlabs: TriggerAdapter | null = null;
  const startStreamlabs = (token: string) => {
    streamlabs?.stop();
    streamlabs = null;
    if (!token) return;
    const sl = createStreamlabsAdapter(token);
    sl.start((tip) => {
      const outcome = engine.onTip(tip);
      log(tag, `streamlabs $${tip.amount} from ${tip.username} → ${outcome}`);
    });
    streamlabs = sl;
  };
  startStreamlabs(row.streamlabsToken ?? "");

  const runtime: ChannelRuntime = {
    channelId,
    engine,
    hub,
    correlation,
    getSettings,
    updateSettings(patch) {
      const next = { ...getSettings(), ...patch };
      db.update(channels)
        .set({ settingsJson: JSON.stringify(next) })
        .where(eq(channels.id, channelId))
        .run();
      return next;
    },
    onTip: (tip) => engine.onTip(tip),
    async mint(durationSec: number): Promise<string> {
      // Gate 1 — job-gated: minting is only legal while a dispatched job for
      // this channel is active, for (at most) that job's remaining time.
      const snap = engine.snapshot();
      if (!snap.activeJob) {
        throw new Error("no active job — token minting is job-gated");
      }
      if (durationSec > snap.activeJob.remainingSec + SESSION_CAP_EXTRA_SEC) {
        throw new Error("requested duration exceeds the active job");
      }
      // Gate 2 — one token per job. Each ek_ token can open its own Decart
      // session, so a router that re-minted on every retry could run N
      // parallel sessions off one paid job — every one billed to us.
      const already = db
        .select({ id: tokenMints.id })
        .from(tokenMints)
        .where(eq(tokenMints.jobId, snap.activeJob.jobId))
        .get();
      if (already) throw new Error("a token was already minted for this job");
      // Gate 3 — monthly budget: hard stop, checked against the audit table
      // (not a counter that can drift). The cap counts what a token can bill
      // at most — paid duration plus the session-cap headroom.
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const used =
        db
          .select({ total: sql<number>`coalesce(sum(capped_sec), 0)` })
          .from(tokenMints)
          .where(
            and(
              eq(tokenMints.channelId, channelId),
              gte(tokenMints.createdAt, monthStart.getTime()),
            ),
          )
          .get()?.total ?? 0;
      const cap = row.monthlyGpuSecondsCap;
      const cappedSec = durationSec + SESSION_CAP_EXTRA_SEC;
      if (used + cappedSec > cap) {
        warn(tag, `monthly GPU cap hit (${used}/${cap}s)`);
        throw new Error("channel GPU budget exhausted for this month");
      }
      // Debit the ledger only once Decart actually issued the token — a
      // failed mint must not eat into the month's budget.
      const token = await mintClientToken(env.decartApiKey, durationSec, "");
      db.insert(tokenMints)
        .values({
          channelId,
          jobId: snap.activeJob.jobId,
          durationSec,
          cappedSec,
          createdAt: Date.now(),
        })
        .run();
      return token;
    },
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
      engine.dispose("channel runtime stopped"); // cancels the active job via the hub
      hub.close();
      runtimes.delete(channelId);
      log(tag, "runtime stopped");
    },
  };

  runtimes.set(channelId, runtime);
  log(tag, "runtime created");
  return runtime;
}
