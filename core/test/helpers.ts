// Shared test scaffolding: a settings factory, a recording EngineEmit, and a
// fake WebSocket the Hub can adopt without a real server.

import { EventEmitter } from "node:events";
import { DEFAULT_SETTINGS, type Settings, type TipEvent } from "@rh/shared";
import { setLogger, type EngineEmit } from "../src/index.js";

// Keep test output clean; the sink is process-global.
setLogger({ log() {}, warn() {}, err() {} });

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, cooldownSec: 0, ...patch };
}

export function tip(patch: Partial<TipEvent> = {}): TipEvent {
  return {
    source: "fake",
    amount: 5,
    message: "",
    username: "viewer",
    isTest: true,
    ...patch,
  };
}

export interface Recorded {
  dispatched: string[];
  cancelled: { jobId: string; reason: string }[];
  updates: { code: string; state: string }[];
  emit: EngineEmit;
}

export function recorder(): Recorded {
  const r: Recorded = {
    dispatched: [],
    cancelled: [],
    updates: [],
    emit: {
      dispatchJob: (job) => r.dispatched.push(job.jobId),
      cancelJob: (jobId, reason) => r.cancelled.push({ jobId, reason }),
      status: () => {},
      submissionUpdate: (code, s) => r.updates.push({ code, state: s.state }),
    },
  };
  return r;
}

/** Minimal stand-in for `ws.WebSocket`: emits 'message'/'close', records
 *  what the hub sent and how it was closed. */
export class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }

  /** Simulate an inbound frame. */
  receive(msg: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 5));
