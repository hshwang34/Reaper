// The engine ↔ hub composition, built ONCE for every host.
//
// Engine and Hub reference each other (the engine dispatches through the hub;
// the hub reports router lifecycle to the engine), so construction is a
// late-bind. Every host used to hand-write that bind — and every host got a
// slightly different lifecycle out of it. This factory owns the wiring, the
// optional host hooks (ledger rows, cloud-mode mirroring), and disposal.

import type { Server } from "node:http";
import { rmSync } from "node:fs";
import { SAFETY_REASON_PREFIX, type HijackJob, type RouterState, type Settings } from "@rh/shared";
import { CorrelationStore } from "./correlation.js";
import { Engine, type EngineEmit } from "./engine.js";
import { Hub, type HubOptions } from "./hub.js";
import { warn } from "./log.js";
import { emptySuite, type ModerationSuite } from "./moderation.js";
import { memorySafetyLedger, StrikeTracker, type SafetyLedger } from "./safetyLedger.js";
import { UploadRegistry } from "./uploadRegistry.js";

export interface RuntimeHooks {
  /** A job was handed to the router (hosted plane writes its ledger row). */
  onDispatch?(job: HijackJob): void;
  /** The router reported a job finished (ledger outcome). */
  onJobDone?(jobId: string, ok: boolean, reason?: string): void;
  /** Mirror of every router lifecycle report, including the synthetic
   *  OFFLINE the hub raises when the last router socket drops. The Electron
   *  bridge forwards these to the cloud engine in cloud mode. */
  onRouterState?(state: RouterState, jobId?: string, remainingSec?: number): void;
  /** The engine cancelled the active job (panic, or the deadline backstop).
   *  The cancel is only *sent* to the router — a frozen router never acts on
   *  it — so a host that can reach the output (OBS) hides it here itself. */
  onCancelJob?(jobId: string, reason: string): void;
}

export interface RuntimeOptions {
  /** Live settings — read fresh on every use. */
  getSettings: () => Settings;
  /** Local mode: the HTTP server the hub attaches `/ws` to. Adopted mode
   *  (hosted front door): null. */
  server: Server | null;
  hub?: HubOptions;
  hooks?: RuntimeHooks;
  /** Log tag for host-visible lifecycle messages. */
  tag?: string;
  /** Content safety (docs/CONTENT-SAFETY.md). Omitted → dev suite (no
   *  classifiers; only valid behind a MOCK model), in-memory ledger. */
  safety?: {
    moderation: ModerationSuite;
    ledger?: SafetyLedger;
    /** How to delete a stored upload. Default: rm the path. */
    deleteUpload?: (path: string) => void;
  };
}

export interface Runtime {
  engine: Engine;
  hub: Hub;
  correlation: CorrelationStore;
  /** Classifier suite the submissions route runs. */
  moderation: ModerationSuite;
  /** Every stored reference image, with its TTL and takedown hashes. */
  uploads: UploadRegistry;
  ledger: SafetyLedger;
  /** Per-submitter rejection strikes (brute-forcing the classifier). */
  strikes: StrikeTracker;
  getSettings: () => Settings;
  /** Push the current status to portals/router (after a settings change). */
  broadcastStatus(): void;
  /** Fail everything in flight, stop timers, drop sockets. Idempotent. */
  dispose(reason?: string): void;
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const tag = opts.tag ?? "runtime";
  const hooks = opts.hooks ?? {};
  const correlation = new CorrelationStore();
  const moderation = opts.safety?.moderation ?? emptySuite(true);
  const ledger = opts.safety?.ledger ?? memorySafetyLedger();
  const strikes = new StrikeTracker();
  const uploads = new UploadRegistry(
    opts.safety?.deleteUpload ?? ((p) => rmSync(p, { force: true })),
  );

  let hub: Hub;
  const emit: EngineEmit = {
    dispatchJob: (job) => {
      hooks.onDispatch?.(job);
      hub.dispatchJob(job);
    },
    cancelJob: (jobId, reason) => {
      hooks.onCancelJob?.(jobId, reason);
      hub.cancelJob(jobId, reason);
    },
    status: (snap) => hub.broadcastStatus(snap),
    submissionUpdate: (code, status) => hub.sendSubmissionUpdate(code, status),
    jobEnded: (job, _ok, reason) => {
      // The reference image's only purpose was this job.
      uploads.release(job.imageUrl, `job ${reason}`);
      if (reason.startsWith(SAFETY_REASON_PREFIX)) {
        ledger.record({
          stage: "output",
          verdict: "reject",
          source: "output-guard",
          reason: reason.slice(SAFETY_REASON_PREFIX.length).trim(),
          categories: ["output"],
          jobId: job.jobId,
          tipper: job.tip.username,
        });
      } else if (reason.startsWith("review: ")) {
        ledger.record({
          stage: "review",
          verdict: "reject",
          source: "streamer",
          reason: reason.slice("review: ".length),
          categories: [],
          jobId: job.jobId,
          tipper: job.tip.username,
        });
      }
    },
    submissionExpired: (code) => uploads.releaseCode(code, "submission expired"),
  };
  const engine = new Engine(correlation, emit, opts.getSettings);

  hub = new Hub(
    opts.server,
    {
      onRouterState: (state, jobId, rem) => {
        engine.setRouterState(state, jobId, rem);
        hooks.onRouterState?.(state, jobId, rem);
      },
      onJobDone: (jobId, ok, reason) => {
        hooks.onJobDone?.(jobId, ok, reason);
        engine.onJobDone(jobId, ok, reason);
      },
      onRouterDisconnected: () => {
        warn(tag, "router disconnected");
        engine.setRouterState("OFFLINE");
        hooks.onRouterState?.("OFFLINE");
      },
      getStatus: () => engine.snapshot(),
    },
    opts.hub,
  );

  let disposed = false;
  return {
    engine,
    hub,
    correlation,
    moderation,
    uploads,
    ledger,
    strikes,
    getSettings: opts.getSettings,
    broadcastStatus: () => hub.broadcastStatus(engine.snapshot()),
    dispose(reason = "runtime disposed") {
      if (disposed) return;
      disposed = true;
      // The engine's cancel reaches the router through the hub, so dispose
      // the engine first, then drop sockets.
      engine.dispose(reason);
      hub.close();
      uploads.dispose();
    },
  };
}
