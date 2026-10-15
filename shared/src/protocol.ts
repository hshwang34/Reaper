// WebSocket message contract between the hub and the pages. Discriminated
// union on `t`. Both directions live in one file so the hub and clients share
// exhaustive typing.
//
// Two planes, deliberately separate:
//   · CONTROL plane — registration, job dispatch, lifecycle reports, status.
//     Traverses the cloud in hosted mode (the Electron cloud link).
//   · LOCAL plane — WebRTC signaling between the router and the OBS viewer
//     page, and the viewer's frames-ok gate. NEVER leaves the streamer's
//     machine: the local hub relays it by role; the hosted hub rejects it
//     (`rejectLocalPlane`). Keeping the planes as distinct types is what lets
//     the hub express that rule as a type guard instead of a string list.

import type {
  HijackJob,
  Role,
  RouterState,
  StatusSnapshot,
  SubmissionStatus,
} from "./types.js";

// ── Control plane: client → server ───────────────────────────────────────

/** First message a page sends: declare its role. */
export interface HelloMsg {
  t: "hello";
  role: Role;
  /** Portal only: the claim code it wants submission updates for. */
  code?: string;
  /** Privileged-role credential (router/viewer). Opaque to the protocol —
   *  the local hub compares it to the per-install token; the hosted front
   *  door verifies it as a session JWT. Absent on public portal connections. */
  auth?: string;
  /** Multi-tenant routing on the hosted control plane. A local
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

// ── Control plane: server → client ───────────────────────────────────────

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

// ── Local plane: router ↔ viewer, relayed by role ────────────────────────

/** The two peers of the loopback. The portal is never a peer. */
export type PeerRole = "router" | "viewer";

/** Structural mirrors of the DOM's RTCSessionDescriptionInit /
 *  RTCIceCandidateInit — declared here so `shared` needs no DOM lib and the
 *  browser can pass them straight to the WebRTC API without casts. */
export interface RtcSdp {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}
export interface RtcCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

interface RtcBase {
  target: PeerRole;
  /** Stamped by the hub from the sending socket's registered role — never
   *  trusted from the payload. Absent on the wire from the client. */
  from?: PeerRole;
  jobId: string;
}
export interface RtcOfferMsg extends RtcBase {
  t: "rtc:offer";
  sdp: RtcSdp;
}
export interface RtcAnswerMsg extends RtcBase {
  t: "rtc:answer";
  sdp: RtcSdp;
}
export interface RtcCandidateMsg extends RtcBase {
  t: "rtc:candidate";
  candidate: RtcCandidate;
}
/** Router tells the viewer to play its out-wipe and drop its peer. */
export interface RtcResetMsg extends RtcBase {
  t: "rtc:reset";
}

/** Viewer confirms media is flowing — the buffering gate. */
export interface ViewerFramesOkMsg {
  t: "viewer:frames-ok";
  jobId: string;
}

export type RtcMsg = RtcOfferMsg | RtcAnswerMsg | RtcCandidateMsg | RtcResetMsg;
export type LocalPlaneMsg = RtcMsg | ViewerFramesOkMsg;

// ── Unions ───────────────────────────────────────────────────────────────

export type ControlClientMsg = HelloMsg | RouterStateMsg | JobDoneMsg;
export type ControlServerMsg =
  | WelcomeMsg
  | JobStartMsg
  | JobCancelMsg
  | StatusMsg
  | SubmissionUpdateMsg;

export type ClientMsg = ControlClientMsg | LocalPlaneMsg;
export type ServerMsg = ControlServerMsg | LocalPlaneMsg;
export type AnyMsg = ClientMsg | ServerMsg;

export function isRtcMsg(m: AnyMsg): m is RtcMsg {
  return (
    m.t === "rtc:offer" ||
    m.t === "rtc:answer" ||
    m.t === "rtc:candidate" ||
    m.t === "rtc:reset"
  );
}

/** Everything that must never leave the streamer's machine. */
export function isLocalPlaneMsg(m: AnyMsg): m is LocalPlaneMsg {
  return isRtcMsg(m) || m.t === "viewer:frames-ok";
}
