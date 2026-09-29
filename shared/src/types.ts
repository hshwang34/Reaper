// Core domain types shared across the sidecar and all three web pages.

/** A page's role in the system. Registered on WS connect. */
export type Role = "portal" | "router" | "viewer";

/** Normalized trigger event — every trigger adapter emits this shape.
 *  "manual" = fired by the streamer from the router console (no payment). */
export interface TipEvent {
  source: "streamlabs" | "twitch-eventsub" | "fake" | "manual";
  /** Amount in USD. */
  amount: number;
  /** Free-text message the tipper attached (may contain the claim code). */
  message: string;
  /** Display name the tip came from. */
  username: string;
  /** True for Streamlabs test donations / the fake dev trigger. */
  isTest?: boolean;
}

/** A pending viewer submission awaiting a matching tip. */
export interface Submission {
  code: string;
  prompt: string;
  presetId: string | null;
  /** Optional name the viewer said they'll tip as (secondary match path). */
  tipperName: string | null;
  /** Sidecar-absolute path to the uploaded reference image, or null. */
  imageUrl: string | null;
  createdAt: number;
  expiresAt: number;
}

/** A fully-resolved hijack ready to run on the router. */
export interface HijackJob {
  jobId: string;
  prompt: string;
  presetId: string | null;
  imageUrl: string | null;
  durationSec: number;
  tip: TipEvent;
  /** How the tip was matched to a submission (for logs / portal display). */
  matchedBy: "code" | "username" | "sole-pending" | "default-preset" | "manual";
}

/** The router's lifecycle state, reported to the sidecar and fanned out.
 *  Exactly the states the machine emits (web/src/router/stateMachine.ts). */
export type RouterState =
  | "OFFLINE" // page not connected / camera released
  | "IDLE" // armed, camera held, ready for a job
  | "AUTHORIZING" // minting token
  | "CONNECTING" // opening Decart WebRTC
  | "BUFFERING" // waiting for verified frames before unhiding OBS
  | "LIVE" // effect visible, counting down
  | "TEARDOWN"; // cleaning up

/** Streamer-configurable policy: pricing, guardrails, catalog. Portable
 *  across hosts and persisted by each (settings.json / userData / the
 *  channel row). Machine wiring — OBS scene/source names, ports, keys — is
 *  NOT settings; it lives in the host's own config. */
export interface Settings {
  minTipUSD: number;
  maxDurationSec: number;
  /** USD → seconds multiplier. Default 1 ($1 = 1s). */
  secondsPerUSD: number;
  queueDepth: number;
  cooldownSec: number;
  /** Preset fired when a tip has no matching submission. */
  defaultPresetId: string;
  /** Preset ids the streamer has enabled (subset of the catalog). */
  enabledPresetIds: string[];
  /** Whether viewers may submit custom free-text prompts at all. */
  allowCustomPrompts: boolean;
  /** Match an unlabeled tip to the only pending submission (correlation rule
   *  3). Convenient on a one-viewer demo rig; on a real channel it hands a
   *  stranger's tip to whoever submitted last, so hosted streamers should
   *  turn it off. */
  allowSolePendingMatch: boolean;
  /** Extra words to reject on top of the built-in blocklist. */
  blocklistExtra: string[];
}

/** Public snapshot the portal renders (no secrets). */
export interface StatusSnapshot {
  routerState: RouterState;
  activeJob: { jobId: string; prompt: string; remainingSec: number } | null;
  queueLength: number;
  paused: boolean;
}

/** Per-submission status pushed to the portal that owns the code. */
export interface SubmissionStatus {
  code: string;
  state:
    | "pending" // waiting for a tip
    | "matched" // a tip arrived, queued
    | "queued" // position in queue
    | "live" // effect running now
    | "done" // completed
    | "expired" // no tip in time
    | "failed"; // matched but the hijack errored
  queuePosition?: number;
  remainingSec?: number;
  message?: string;
}
