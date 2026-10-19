// The router state machine's side effects, as an interface.
//
// The machine's two promises — teardown is idempotent, and OBS is hidden
// BEFORE the Decart session drops on every exit path — are only worth
// anything if they can be asserted. With the effects behind this seam the
// machine runs under node:test against fakes (web/test/stateMachine.test.ts);
// `browserPorts()` is the one real implementation the /router page uses.

import type { ClientMsg, OverlayChips } from "@rh/shared";
import { api } from "../lib/api.js";
import type { HubSocket } from "../lib/ws.js";
import type { LoopbackSender } from "../lib/loopback.js";
import { DecartSession, type StartArgs } from "./decartSession.js";

export interface DecartPort {
  start(args: StartArgs): Promise<void>;
  disconnect(): void;
}

export interface SenderPort {
  /** `overlay` rides the offer to the viewer page (attribution / AI label). */
  start(jobId: string, stream: MediaStream, overlay?: OverlayChips): Promise<void>;
  sendReset(): void;
  stop(): void;
}

export interface GuardVerdict {
  unsafe: boolean;
  /** Classifier class that decided ("Porn", "Hentai", "Sexy", "ok", …). */
  label: string;
  score: number;
}

/** The output guard (CONTENT-SAFETY S4) — frameGuard.ts in the browser. */
export interface GuardPort {
  /** Load the model if needed; false when it can't run on this machine. */
  ready(): Promise<boolean>;
  /** Classify one frame of `stream` now. */
  check(stream: MediaStream): Promise<GuardVerdict>;
  /** Sample continuously; calls onUnsafe once after consecutive positives.
   *  Returns the stop function. */
  watch(stream: MediaStream, onUnsafe: (v: GuardVerdict) => void): () => void;
}

export interface MachinePorts {
  /** Mint a per-job ek_ token (or "MOCK") from whichever host gates it. */
  mintToken(durationSec: number): Promise<string>;
  /** Show/hide the OBS Browser Source. Rejects when OBS is unreachable. */
  setObsVisible(visible: boolean): Promise<void>;
  /** Resolve a reference image; null on any failure (the job continues). */
  fetchImage(url: string): Promise<Blob | null>;
  decart: DecartPort;
  sender: SenderPort;
  guard: GuardPort;
  /** Uplink to the hub (router:state, job:done). */
  send(msg: ClientMsg): void;
}

/** Timing knobs — overridable so tests run in milliseconds, never seconds. */
export interface MachineTimeouts {
  connectMs: number;
  bufferMs: number;
  /** Beyond the paid duration, before the watchdog fires. */
  watchdogExtraMs: number;
  /** Glitch-wipe cover between the cut and the OBS hide. */
  wipeMs: number;
  /** Budget for the guard's model load + first-frame check before LIVE. */
  guardMs: number;
}

export const DEFAULT_TIMEOUTS: MachineTimeouts = {
  connectMs: 10_000,
  bufferMs: 8_000,
  watchdogExtraMs: 10_000,
  wipeMs: 420,
  guardMs: 4_000,
};

/** The real thing: HTTP API + Decart SDK + WebRTC loopback + hub socket. */
export function browserPorts(
  hub: HubSocket,
  sender: LoopbackSender,
  guard: GuardPort,
): MachinePorts {
  return {
    mintToken: (d) => api.mintToken(d).then((r) => r.token),
    setObsVisible: (visible) => api.obsToggle(visible).then(() => undefined),
    fetchImage: (url) =>
      fetch(url)
        .then((r) => r.blob())
        .catch(() => null),
    decart: new DecartSession(),
    sender,
    guard,
    send: (m) => hub.send(m),
  };
}
