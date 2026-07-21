// WebSocket message contract between the sidecar hub and the three pages.
// Discriminated union on `t`. Keep both directions in one union so the hub
// and clients share exhaustive typing.

import type {
  HijackJob,
  Role,
  RouterState,
  StatusSnapshot,
  SubmissionStatus,
} from "./types.js";

// ── Client → Server ──────────────────────────────────────────────────────

/** First message a page sends: declare its role. */
export interface HelloMsg {
  t: "hello";
  role: Role;
  /** Portal only: the claim code it wants submission updates for. */
  code?: string;
  /** Privileged-role auth (router/viewer). Local hosts use a per-install
   *  token (Electron preload / provisioned OBS URL); the hosted control
   *  plane uses a session JWT. Absent on public portal connections. */
  auth?: string;
  /** Multi-tenant routing on the hosted control plane (M3). A local
   *  single-streamer hub ignores it. */
  channel?: string;
}

/** Router reports a lifecycle transition. */
export interface RouterStateMsg {
  t: "router:state";
  state: RouterState;
  jobId?: string;
  remainingSec?: number;
}

/** Router reports a job finished (ok) or failed. */
export interface JobDoneMsg {
  t: "job:done";
  jobId: string;
  ok: boolean;
  reason?: string;
}

/** Viewer confirms N verified decoded frames — the buffering gate. */
export interface ViewerFramesOkMsg {
  t: "viewer:frames-ok";
  jobId: string;
}

// ── Server → Client ──────────────────────────────────────────────────────

/** Ack of registration. */
export interface WelcomeMsg {
  t: "welcome";
  role: Role;
}

/** Hub dispatches a job to the router. */
export interface JobStartMsg {
  t: "job:start";
  job: HijackJob;
}

/** Hub tells the router to abort the current job (panic / cancel). */
export interface JobCancelMsg {
  t: "job:cancel";
  jobId: string;
  reason: string;
}

/** Broadcast status snapshot (to portals + router UI). */
export interface StatusMsg {
  t: "status";
  status: StatusSnapshot;
}

/** Per-code submission status (to the owning portal). */
export interface SubmissionUpdateMsg {
  t: "submission:update";
  status: SubmissionStatus;
}

// ── RTC signaling (relayed by role) ──────────────────────────────────────

export interface RtcOfferMsg {
  t: "rtc:offer";
  target: Role;
  from?: Role;
  jobId: string;
  sdp: unknown;
}
export interface RtcAnswerMsg {
  t: "rtc:answer";
  target: Role;
  from?: Role;
  jobId: string;
  sdp: unknown;
}
export interface RtcCandidateMsg {
  t: "rtc:candidate";
  target: Role;
  from?: Role;
  jobId: string;
  candidate: unknown;
}
/** Router tells viewer to reset its peer connection for a new job. */
export interface RtcResetMsg {
  t: "rtc:reset";
  target: Role;
  from?: Role;
  jobId: string;
}

export type ClientMsg =
  | HelloMsg
  | RouterStateMsg
  | JobDoneMsg
  | ViewerFramesOkMsg
  | RtcOfferMsg
  | RtcAnswerMsg
  | RtcCandidateMsg
  | RtcResetMsg;

export type ServerMsg =
  | WelcomeMsg
  | JobStartMsg
  | JobCancelMsg
  | StatusMsg
  | SubmissionUpdateMsg
  | RtcOfferMsg
  | RtcAnswerMsg
  | RtcCandidateMsg
  | RtcResetMsg;

export type AnyMsg = ClientMsg | ServerMsg;

/** RTC messages are the ones the hub blindly forwards to `target`. */
export type RtcMsg =
  | RtcOfferMsg
  | RtcAnswerMsg
  | RtcCandidateMsg
  | RtcResetMsg;

export function isRtcMsg(m: AnyMsg): m is RtcMsg {
  return (
    m.t === "rtc:offer" ||
    m.t === "rtc:answer" ||
    m.t === "rtc:candidate" ||
    m.t === "rtc:reset"
  );
}
