// The money path: tip → matched job → duration → FIFO queue → dispatch.
//
// One job runs on the router at a time (never extend an active session; each
// job gets a clean init/teardown per FEASIBILITY §3). Overlapping tips queue
// FIFO up to settings.queueDepth. A cooldown gap between jobs lets teardown
// settle before the next init.

import { randomUUID } from "node:crypto";
import {
  getPreset,
  type HijackJob,
  type RouterState,
  type StatusSnapshot,
  type SubmissionStatus,
  type TipEvent,
} from "@rh/shared";
import { getSettings } from "./config.js";
import { CorrelationStore } from "./correlation.js";
import { log, warn } from "./log.js";

export interface EngineEmit {
  dispatchJob(job: HijackJob): void;
  cancelJob(jobId: string, reason: string): void;
  status(snapshot: StatusSnapshot): void;
  submissionUpdate(code: string, status: Omit<SubmissionStatus, "code">): void;
}

export class Engine {
  private queue: HijackJob[] = [];
  private active: HijackJob | null = null;
  private activeRemaining = 0;
  private routerState: RouterState = "OFFLINE";
  private paused = false;
  private cooldownUntil = 0;
  /** jobId → originating submission code (null for default-preset jobs). */
  private jobCode = new Map<string, string | null>();

  constructor(
    public readonly correlation: CorrelationStore,
    private emit: EngineEmit,
  ) {
    correlation.onExpire = (code) =>
      this.emit.submissionUpdate(code, {
        state: "expired",
        message: "No matching tip arrived in time.",
      });
  }

  // ── Trigger entry point ────────────────────────────────────────────────

  /** Handle a normalized tip. Returns a human-readable outcome for logs/API. */
  onTip(tip: TipEvent): string {
    const s = getSettings();
    if (tip.amount < s.minTipUSD) {
      warn("engine", `tip $${tip.amount} below min $${s.minTipUSD} — ignored`);
      return `ignored: below min tip ($${s.minTipUSD})`;
    }

    const durationSec = Math.min(
      Math.max(1, Math.floor(tip.amount * s.secondsPerUSD)),
      s.maxDurationSec,
    );

    const { submission, matchedBy } = this.correlation.match(tip);

    let prompt: string;
    let presetId: string | null;
    let imageUrl: string | null;
    if (submission) {
      prompt = submission.prompt;
      presetId = submission.presetId;
      imageUrl = submission.imageUrl;
    } else {
      const preset = getPreset(s.defaultPresetId) ?? getPreset("80s-anime")!;
      prompt = preset.prompt;
      presetId = preset.id;
      imageUrl = null;
    }

    const job: HijackJob = {
      jobId: randomUUID(),
      prompt,
      presetId,
      imageUrl,
      durationSec,
      tip,
      matchedBy,
    };
    this.jobCode.set(job.jobId, submission?.code ?? null);

    return this.enqueue(job);
  }

  private enqueue(job: HijackJob): string {
    const s = getSettings();
    if (this.queue.length >= s.queueDepth) {
      warn("engine", `queue full (${s.queueDepth}) — dropping job`);
      this.notify(job, { state: "failed", message: "Queue is full." });
      return "dropped: queue full";
    }
    this.queue.push(job);
    log(
      "engine",
      `+job ${job.jobId.slice(0, 8)} ${job.durationSec}s (${job.matchedBy}), queue=${this.queue.length}`,
    );
    this.notify(job, {
      state: "matched",
      queuePosition: this.queue.length,
      message: `Matched — ${job.durationSec}s hijack queued.`,
    });
    this.broadcast();
    this.tryDispatch();
    return `queued (${job.durationSec}s, ${job.matchedBy})`;
  }

  // ── Router lifecycle feedback ──────────────────────────────────────────

  setRouterState(state: RouterState, jobId?: string, remainingSec?: number): void {
    this.routerState = state;
    if (state === "LIVE" && this.active && jobId === this.active.jobId) {
      this.activeRemaining = remainingSec ?? this.activeRemaining;
      this.notify(this.active, {
        state: "live",
        remainingSec: this.activeRemaining,
        message: "Your hijack is LIVE.",
      });
    }
    this.broadcast();
    if (state === "IDLE") this.tryDispatch();
  }

  onJobDone(jobId: string, ok: boolean, reason?: string): void {
    if (this.active && this.active.jobId === jobId) {
      this.notify(this.active, {
        state: ok ? "done" : "failed",
        message: ok ? "Hijack complete." : `Hijack failed: ${reason ?? "error"}`,
      });
      this.jobCode.delete(jobId);
      this.active = null;
      this.activeRemaining = 0;
    }
    // Cooldown before the next job inits.
    this.cooldownUntil = Date.now() + getSettings().cooldownSec * 1000;
    this.broadcast();
    setTimeout(() => this.tryDispatch(), getSettings().cooldownSec * 1000 + 50);
  }

  private tryDispatch(): void {
    if (this.paused || this.active) return;
    if (this.routerState !== "IDLE") return;
    if (Date.now() < this.cooldownUntil) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    this.activeRemaining = job.durationSec;
    log("engine", `→dispatch ${job.jobId.slice(0, 8)} to router`);
    this.emit.dispatchJob(job);
    // Update queued positions for everyone still waiting.
    this.queue.forEach((q, i) =>
      this.notify(q, { state: "queued", queuePosition: i + 1 }),
    );
    this.broadcast();
  }

  // ── Panic / pause ──────────────────────────────────────────────────────

  pause(): void {
    this.paused = true;
    if (this.active) {
      this.emit.cancelJob(this.active.jobId, "panic");
    }
    warn("engine", "PAUSED (panic)");
    this.broadcast();
  }

  resume(): void {
    this.paused = false;
    log("engine", "resumed");
    this.broadcast();
    this.tryDispatch();
  }

  togglePause(): boolean {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  // ── Snapshots ──────────────────────────────────────────────────────────

  snapshot(): StatusSnapshot {
    return {
      routerState: this.routerState,
      activeJob: this.active
        ? {
            jobId: this.active.jobId,
            prompt: this.active.prompt,
            remainingSec: this.activeRemaining,
          }
        : null,
      queueLength: this.queue.length,
      paused: this.paused,
    };
  }

  private broadcast(): void {
    this.emit.status(this.snapshot());
  }

  private notify(job: HijackJob, status: Omit<SubmissionStatus, "code">): void {
    const code = this.jobCode.get(job.jobId);
    if (code) this.emit.submissionUpdate(code, status);
  }
}
