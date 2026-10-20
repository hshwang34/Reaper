// Shared test scaffolding: a settings factory, a recording EngineEmit, and a
// fake WebSocket the Hub can adopt without a real server.

import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DEFAULT_SETTINGS, type HijackJob, type Settings, type TipEvent } from "@rh/shared";
import {
  CorrelationStore,
  emptySuite,
  memorySafetyLedger,
  setLogger,
  StrikeTracker,
  UploadRegistry,
  type ClassifierVerdict,
  type EngineEmit,
  type ImageClassifier,
  type ImageVerdict,
  type IntakeDeps,
  type ModerationSuite,
  type TextClassifier,
} from "../src/index.js";

// Keep test output clean; the sink is process-global.
setLogger({ log() {}, warn() {}, err() {} });

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, cooldownSec: 0, ...patch };
}

// ── Content-safety scaffolding ───────────────────────────────────────────

export const allow: ClassifierVerdict = { verdict: "allow", categories: [], reason: "clean" };

/** A text classifier that answers from a function, recording what it saw. */
export function fakeText(
  decide: (text: string) => ClassifierVerdict | Error = () => allow,
  name = "fake-text",
  role: TextClassifier["role"] = "floor",
): TextClassifier & { seen: string[] } {
  const seen: string[] = [];
  return {
    name,
    role,
    seen,
    async classifyText(text) {
      seen.push(text);
      const v = decide(text);
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

export function fakeImage(
  v: Partial<ImageVerdict> | Error = {},
  opts: { coversMinors?: boolean; name?: string } = {},
): ImageClassifier & { calls: number } {
  const c = {
    name: opts.name ?? "fake-image",
    coversMinors: opts.coversMinors ?? true,
    calls: 0,
    async classifyImage(): Promise<ImageVerdict> {
      c.calls++;
      if (v instanceof Error) throw v;
      return { ...allow, faces: 0, minorPossible: false, sexual: false, ...v };
    },
  };
  return c;
}

export function liveSuite(text: TextClassifier[] = [], image: ImageClassifier[] = []): ModerationSuite {
  return { text, image, devMode: false };
}

/** Intake deps around a fresh store; dispose() stops the timers. */
export function intakeDeps(
  s: Settings = settings(),
  moderation: ModerationSuite = emptySuite(true),
): IntakeDeps & { deleted: string[]; dispose(): void } {
  const deleted: string[] = [];
  const store = new CorrelationStore();
  const uploads = new UploadRegistry((p) => deleted.push(p));
  return {
    store,
    settings: s,
    moderation,
    uploads,
    ledger: memorySafetyLedger(),
    strikes: new StrikeTracker(),
    deleted,
    dispose() {
      store.dispose();
      uploads.dispose();
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "rh-test-"));
let n = 0;

/** Write a real image to disk under a host-style name; returns its path. */
export async function imageFile(
  opts: { ext?: ".jpg" | ".png" | ".webp"; size?: number; bytes?: Buffer } = {},
): Promise<string> {
  const ext = opts.ext ?? ".jpg";
  const path = join(tmp, `${Date.now()}-${n++}${ext}`);
  if (opts.bytes) {
    writeFileSync(path, opts.bytes);
    return path;
  }
  const size = opts.size ?? 256;
  const fmt = ext === ".png" ? "png" : ext === ".webp" ? "webp" : "jpeg";
  const buf = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: size / 2, height: size / 2, channels: 3, background: "#0af" },
        })
          .png()
          .toBuffer(),
        top: 8,
        left: 8,
      },
    ])
    .withMetadata({ exif: { IFD0: { Copyright: "secret-gps-owner" } } })
    .toFormat(fmt)
    .toBuffer();
  writeFileSync(path, buf);
  return path;
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
  /** The full dispatched jobs, same order as `dispatched`. */
  jobs: HijackJob[];
  cancelled: { jobId: string; reason: string }[];
  updates: { code: string; state: string }[];
  emit: EngineEmit;
}

export function recorder(): Recorded {
  const r: Recorded = {
    dispatched: [],
    jobs: [],
    cancelled: [],
    updates: [],
    emit: {
      dispatchJob: (job) => {
        r.dispatched.push(job.jobId);
        r.jobs.push(job);
      },
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
