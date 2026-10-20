// Core domain types shared across the sidecar and all three web pages.

/** A page's role in the system. Registered on WS connect. */
export type Role = "portal" | "router" | "viewer";

/** Normalized trigger event — every trigger adapter emits this shape.
 *  "manual" = fired by the streamer from the router console (no payment). */
export interface TipEvent {
  source: "streamlabs" | "twitch-eventsub" | "stripe" | "fake" | "manual";
  /** Amount in USD. */
  amount: number;
  /** Free-text message the tipper attached (may contain the claim code). */
  message: string;
  /** Display name the tip came from. */
  username: string;
  /** True for Streamlabs test donations / the fake dev trigger. */
  isTest?: boolean;
  /** The host's record of the money behind this tip (hosted: a payments row
   *  id). Rides on the job so its outcome can settle the payment —
   *  delivered, or refunded if the hijack never happened. */
  ref?: string;
}

/** A pending viewer submission awaiting a matching tip. */
export interface Submission {
  code: string;
  prompt: string;
  presetId: string | null;
  /** Optional name the viewer said they'll tip as (secondary match path). */
  tipperName: string | null;
  /** URL of the uploaded reference image, or null. Host-relative on the local
   *  rig (`/uploads/x.jpg`, same-origin to the router page); absolute on the
   *  hosted control plane, because the job is dispatched down to the streamer's
   *  machine and the router there must be able to fetch it cross-origin. */
  imageUrl: string | null;
  /** Decart "enhance prompt": let the model's prompt-rewriter expand the text
   *  (Decart default = on). Off = the prompt is used literally, which is what
   *  you want for precise edits or when the reference image carries the intent. */
  enhance: boolean;
  /** Content safety: the streamer must approve this one before it runs
   *  (approval tier, a likeness swap under `reviewLikeness`, or a borderline
   *  classifier verdict). See docs/CONTENT-SAFETY.md S3. */
  needsReview?: boolean;
  /** Why it needs review — shown to the streamer on the approval card. */
  reviewWhy?: string;
  /** Recorded likeness-consent attestation (Decart API Terms §4.3). */
  consent?: ConsentRecord;
  createdAt: number;
  expiresAt: number;
}

/** The likeness-consent statement. The portal shows exactly this string next
 *  to the checkbox and the server stores exactly this string with the
 *  submission, so the record says what the viewer actually saw. */
export const CONSENT_STATEMENT =
  "I'm 18 or older, and this photo is of me — or I have the permission of the adult pictured to use their likeness live on stream.";

/** What the viewer affirmed when submitting a photo with a face in it. */
export interface ConsentRecord {
  /** The exact statement they ticked — stored verbatim, not a flag. */
  statement: string;
  at: number;
  /** Salted hash of the submitting IP (never the raw address). */
  ipHash: string;
}

/** Output-frame guard mode (CONTENT-SAFETY S4):
 *  · off      — no guard
 *  · on       — guard runs; a positive tears down; guard unavailable → run anyway
 *  · required — as on, but a job carrying viewer bytes (custom text or an
 *               image) aborts before LIVE if the guard can't run */
export type OutputGuardMode = "off" | "on" | "required";

/** A fully-resolved hijack ready to run on the router. */
export interface HijackJob {
  jobId: string;
  prompt: string;
  presetId: string | null;
  imageUrl: string | null;
  /** See Submission.enhance — travels with the job to the router untouched. */
  enhance: boolean;
  durationSec: number;
  tip: TipEvent;
  /** How the tip was matched to a submission (for logs / portal display). */
  matchedBy: "code" | "username" | "sole-pending" | "default-preset" | "manual";
  /** Content safety, stamped by the engine from the streamer's policy so the
   *  router needs no settings of its own. Optional on the wire for old
   *  routers; absent = guard off, no overlay. */
  safety?: JobSafety;
}

export interface JobSafety {
  outputGuard: OutputGuardMode;
  /** No viewer-authored bytes reach the model: a preset with no image, or the
   *  streamer's own console. `required` only blocks untrusted jobs. */
  trusted: boolean;
  /** On-stream overlay chips (Twitch Extension §7.3 attribution; Kick's
   *  realistic-AI disclosure). */
  attribution: string | null;
  aiLabel: boolean;
}

/** Router → hub `job:done` reasons that start with this are safety stops
 *  (output guard / guard unavailable). Encoded in the reason rather than a
 *  new message so every relay path — including the Electron cloud link —
 *  carries it unchanged. */
export const SAFETY_REASON_PREFIX = "safety:";

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
  /** Preset ids the streamer switched OFF. Opt-out, so presets added to
   *  the catalog later reach existing channels without a migration. */
  disabledPresetIds: string[];
  /** Match an unlabeled tip to the only pending submission (correlation rule
   *  3). Convenient on a one-viewer demo rig; on a real channel it hands a
   *  stranger's tip to whoever submitted last, so hosted streamers should
   *  turn it off. */
  allowSolePendingMatch: boolean;

  // ── Content policy (docs/CONTENT-SAFETY.md S0) ────────────────────────
  // The streamer's knobs sit ABOVE a floor we own (nudity, minors, NCII,
  // impersonation, gore) that no setting can lower.

  /** Viewer-authored text: never / classified / classified + streamer approval. */
  customPrompts: CustomPromptTier;
  /** Preset catalog ceiling — presets above it are hidden and refused. */
  maxIntensity: number;
  allowedCategories: PresetCategory[];
  /** Reference images: none / scene-and-style refs (no faces) / likeness
   *  swaps with a recorded consent attestation. */
  referenceImages: ReferenceImageTier;
  /** Classifier thresholds. */
  moderationStrictness: "strict" | "standard";
  outputGuard: OutputGuardMode;
  /** Let Decart rewrite CUSTOM text. Off by default: the classifier must
   *  score the text the model actually runs. Presets keep the viewer's toggle. */
  enhanceCustomPrompts: boolean;
  /** Every likeness swap (a photo with a face) waits for streamer approval. */
  reviewLikeness: boolean;
  /** On-stream chips: "hijacked by <name>" and "AI-altered". */
  showAttribution: boolean;
  showAiLabel: boolean;
  /** Extra words to reject on top of the built-in blocklist. */
  blocklistExtra: string[];
  /** Tipper names whose submissions are refused and whose tips run the
   *  default preset instead (case-insensitive). */
  bannedViewers: string[];
}

export type CustomPromptTier = "off" | "classified" | "classified+approval";
export type ReferenceImageTier = "off" | "scenes" | "likeness";
export type PresetCategory = "environment" | "character" | "horror" | "chaotic";
export const PRESET_CATEGORIES: PresetCategory[] = [
  "environment",
  "character",
  "horror",
  "chaotic",
];

/** Public snapshot the portal renders (no secrets). */
export interface StatusSnapshot {
  routerState: RouterState;
  /** `prompt` is public (every portal sees it), so a custom prompt is shown
   *  as a neutral label rather than broadcasting viewer text. */
  activeJob: { jobId: string; prompt: string; remainingSec: number } | null;
  queueLength: number;
  paused: boolean;
  /** Paid jobs parked for streamer approval (count only — public). */
  reviewPending?: number;
}

/** A paid job waiting on the streamer (CONTENT-SAFETY S3). Streamer-only. */
export interface ReviewItem {
  jobId: string;
  code: string | null;
  prompt: string;
  presetId: string | null;
  imageUrl: string | null;
  tipper: string;
  amount: number;
  durationSec: number;
  /** Why it's parked: "approval tier", "likeness swap", or a classifier reason. */
  why: string;
  expiresAt: number;
}

/** One moderation decision — the audit/appeal/takedown trail (S5). */
export interface ModerationEvent {
  id: string;
  ts: number;
  stage: "text" | "image" | "review" | "output" | "report" | "takedown" | "ban";
  verdict: "allow" | "reject" | "review" | "error" | "info";
  /** Which check decided: "blocklist", "openai", "claude", "sightengine",
   *  "structure", "streamer", "output-guard", "viewer". */
  source: string;
  reason: string;
  categories: string[];
  code?: string | null;
  jobId?: string | null;
  /** sha256 of the moderated text or image bytes — never the bytes. */
  inputHash?: string | null;
  ipHash?: string | null;
  tipper?: string | null;
}

/** Per-submission status pushed to the portal that owns the code. */
export interface SubmissionStatus {
  code: string;
  state:
    | "pending" // waiting for a tip
    | "review" // tip arrived; waiting for the streamer to approve
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
