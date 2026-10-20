// The money path: tip → matched job → duration → FIFO queue → dispatch.
//
// One job runs on the router at a time (never extend an active session; each
// job gets a clean init/teardown per FEASIBILITY §3). Overlapping tips queue
// FIFO up to settings.queueDepth. A cooldown gap between jobs lets teardown
// settle before the next init.

import { randomUUID } from "node:crypto";
import {
  computeDurationSec,
  getPreset,
  SAFETY_REASON_PREFIX,
  type HijackJob,
  type JobSafety,
  type ReviewItem,
  type RouterState,
  type Settings,
  type StatusSnapshot,
  type SubmissionStatus,
  type TipEvent,
} from "@rh/shared";
import { CorrelationStore } from "./correlation.js";
import { isBanned } from "./submissions.js";
import { displayName } from "./moderation.js";
import { log, warn } from "./log.js";

export interface EngineEmit {
  dispatchJob(job: HijackJob): void;
  cancelJob(jobId: string, reason: string): void;
  status(snapshot: StatusSnapshot): void;
  submissionUpdate(code: string, status: Omit<SubmissionStatus, "code">): void;
  /** A job left the engine for good — finished, failed, dropped, declined,
   *  timed out in review, or cancelled on dispose. Hosts release its upload
   *  and write safety records here. */
  jobEnded?(job: HijackJob, ok: boolean, reason: string): void;
  /** A submission expired with no tip (its upload can go). */
  submissionExpired?(code: string): void;
}

/** How long a paid job may wait for the streamer's approval before it fails
 *  (CONTENT-SAFETY S3). Long enough to glance at a card mid-stream. */
export const REVIEW_TTL_MS = 120_000;

interface Parked {
  job: HijackJob;
  code: string | null;
  why: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

// Engine-side backstop: how long past a job's paid duration we wait for the
// router to report `job:done` before force-failing it to free the queue. Must
// comfortably exceed the router's worst-case healthy wall-time (AUTHORIZING +
// ≤10s connect + ≤8s buffer + duration + its own duration+10s watchdog), so it
// only ever fires when the router genuinely died mid-job. This frees the queue;
// runaway billing is already bounded independently by the token's
// maxSessionDuration (see decart.ts).
const JOB_DEADLINE_GRACE_MS = 45_000;

/** Last-resort preset when the streamer's configured default is unknown. */
const FALLBACK_PRESET_ID = "80s-anime";

export class Engine {
  private queue: HijackJob[] = [];
  private active: HijackJob | null = null;
  private activeRemaining = 0;
  private routerState: RouterState = "OFFLINE";
  private paused = false;
  private cooldownUntil = 0;
  /** Backstop timer for the active job; cleared when it reports done. */
  private jobDeadline?: ReturnType<typeof setTimeout>;
  /** Wakes tryDispatch once the cooldown after the last job has elapsed. */
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  /** jobId → originating submission code, for queued/active jobs only. */
  private jobCode = new Map<string, string>();
  /** Paid jobs waiting on the streamer, by jobId. */
  private parked = new Map<string, Parked>();
  private disposed = false;

  constructor(
    public readonly correlation: CorrelationStore,
    private emit: EngineEmit,
    /** Settings provider, injected by the host (sidecar reads settings.json;
     *  the hosted control plane reads the channel row; Electron reads
     *  userData). Read fresh on every use so live edits apply immediately. */
    private getSettings: () => Settings,
  ) {
    correlation.onExpire = (code) => {
      this.emit.submissionUpdate(code, {
        state: "expired",
        message: "No matching tip arrived in time.",
      });
      this.emit.submissionExpired?.(code);
    };
  }

  // ── Trigger entry point ────────────────────────────────────────────────

  /** Handle a normalized tip. Returns a human-readable outcome for logs/API. */
  onTip(tip: TipEvent): string {
    const s = this.getSettings();
    if (tip.amount < s.minTipUSD) {
      warn("engine", `tip $${tip.amount} below min $${s.minTipUSD} — ignored`);
      return `ignored: below min tip ($${s.minTipUSD})`;
    }

    const durationSec = computeDurationSec(tip.amount, s);
    // A banned tipper's money still buys a hijack — the streamer's default
    // preset, never their own content. Matching is skipped entirely so a
    // banned tip can't consume (and burn) someone else's pending code.
    const banned = isBanned(s, tip.username);
    if (banned) warn("engine", `tip from banned viewer ${tip.username} → default preset`);
    const { submission, matchedBy } = banned
      ? { submission: null, matchedBy: "default-preset" as const }
      : this.correlation.match(tip, { allowSolePendingMatch: s.allowSolePendingMatch });

    let prompt: string;
    let presetId: string | null;
    let imageUrl: string | null;
    let enhance: boolean;
    if (submission) {
      prompt = submission.prompt;
      presetId = submission.presetId;
      imageUrl = submission.imageUrl;
      enhance = submission.enhance;
    } else {
      const preset = getPreset(s.defaultPresetId) ?? getPreset(FALLBACK_PRESET_ID)!;
      prompt = preset.prompt;
      presetId = preset.id;
      imageUrl = null;
      enhance = true; // Decart's default; preset text is written to be enhanced
    }

    const job: HijackJob = {
      jobId: randomUUID(),
      prompt,
      presetId,
      imageUrl,
      enhance,
      durationSec,
      tip,
      matchedBy,
      safety: jobSafety(s, presetId !== null && imageUrl === null, tip.username),
    };
    if (submission?.needsReview) {
      return this.park(job, submission.code, submission.reviewWhy || "needs approval");
    }
    return this.enqueue(job, submission?.code ?? null);
  }

  /** Streamer-fired hijack from the router console: no payment, no matching,
   *  no min-tip — but the same duration cap, queue, and state machine. */
  manual(prompt: string, durationSec: number): string {
    const s = this.getSettings();
    const d = Math.min(Math.max(1, Math.floor(durationSec)), s.maxDurationSec);
    const job: HijackJob = {
      jobId: randomUUID(),
      prompt,
      presetId: null,
      imageUrl: null,
      enhance: true,
      durationSec: d,
      tip: {
        source: "manual",
        amount: 0,
        message: "(streamer console)",
        username: "streamer",
        isTest: true,
      },
      matchedBy: "manual",
      // The streamer typed it: trusted, and no attribution chip.
      safety: { ...jobSafety(s, true, null), attribution: null },
    };
    return this.enqueue(job, null);
  }

  // ── Streamer approval (CONTENT-SAFETY S3) ──────────────────────────────

  private park(job: HijackJob, code: string, why: string): string {
    const s = this.getSettings();
    if (this.parked.size >= Math.max(1, s.queueDepth)) {
      warn("engine", "review backlog full — dropping job");
      this.emit.submissionUpdate(code, { state: "failed", message: "The streamer's approval queue is full." });
      this.emit.jobEnded?.(job, false, "review backlog full");
      return "dropped: review backlog full";
    }
    const timer = setTimeout(() => {
      if (!this.parked.has(job.jobId)) return;
      this.decideReview(job.jobId, false, "not approved in time");
    }, REVIEW_TTL_MS);
    timer.unref?.();
    this.parked.set(job.jobId, { job, code, why, expiresAt: Date.now() + REVIEW_TTL_MS, timer });
    this.emit.submissionUpdate(code, {
      state: "review",
      message: "Tip received — waiting for the streamer to approve your effect.",
    });
    log("engine", `+review ${job.jobId.slice(0, 8)} (${why})`);
    this.broadcast();
    return `parked for streamer approval (${why})`;
  }

  /** Approve → the job joins the queue as if it had just arrived. Decline /
   *  timeout → the viewer is told and the job ends (its upload is released). */
  decideReview(jobId: string, approve: boolean, reason?: string): boolean {
    const p = this.parked.get(jobId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.parked.delete(jobId);
    if (approve) {
      log("engine", `review ${jobId.slice(0, 8)} approved`);
      this.enqueue(p.job, p.code);
    } else {
      const why = reason ?? "declined by the streamer";
      log("engine", `review ${jobId.slice(0, 8)} rejected (${why})`);
      if (p.code) {
        this.emit.submissionUpdate(p.code, {
          state: "failed",
          message:
            why === "not approved in time"
              ? "The streamer didn't approve this effect in time."
              : "The streamer declined this effect.",
        });
      }
      this.emit.jobEnded?.(p.job, false, `review: ${why}`);
      this.broadcast();
    }
    return true;
  }

  pendingReviews(): ReviewItem[] {
    return [...this.parked.values()].map((p) => ({
      jobId: p.job.jobId,
      code: p.code,
      prompt: p.job.prompt,
      presetId: p.job.presetId,
      imageUrl: p.job.imageUrl,
      tipper: p.job.tip.username,
      amount: p.job.tip.amount,
      durationSec: p.job.durationSec,
      why: p.why,
      expiresAt: p.expiresAt,
    }));
  }

  private enqueue(job: HijackJob, code: string | null): string {
    const s = this.getSettings();
    if (this.queue.length >= s.queueDepth) {
      warn("engine", `queue full (${s.queueDepth}) — dropping job`);
      // Not tracked in jobCode (it never enters the queue), so notify directly.
      if (code) {
        this.emit.submissionUpdate(code, { state: "failed", message: "Queue is full." });
      }
      this.emit.jobEnded?.(job, false, "queue full");
      return "dropped: queue full";
    }
    if (code) this.jobCode.set(job.jobId, code);
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
    // The router vanished (tab closed/crashed/disarmed, or WS dropped) with a
    // job in flight. Its Decart session and OBS state died with it, and no
    // job:done will ever arrive — so fail the job now instead of stalling the
    // queue forever. Decart's server-side cap already stops any billing.
    if (state === "OFFLINE" && this.active) {
      this.finishActive(false, "router disconnected mid-hijack");
    }
    this.broadcast();
    if (state === "IDLE") this.tryDispatch();
  }

  onJobDone(jobId: string, ok: boolean, reason?: string): void {
    // Ignore stale reports for a job we've already cleared (e.g. after an
    // engine-side deadline or a router-loss fail).
    if (this.active?.jobId === jobId) this.finishActive(ok, reason ?? "error");
  }

  /** Backstop fired when the router never reported a job done in time. */
  private onJobDeadline(jobId: string): void {
    if (this.active?.jobId !== jobId) return;
    warn("engine", `job ${jobId.slice(0, 8)} exceeded deadline — force-failing`);
    // Best-effort: tell the router to tear down in case it's a live zombie.
    this.emit.cancelJob(jobId, "engine deadline");
    this.finishActive(false, "router never reported completion");
  }

  /** Complete the active job — router-reported or engine-forced — and open the
   *  cooldown before the next dispatch. Safe no-op when nothing is active. */
  private finishActive(ok: boolean, reason: string): void {
    const job = this.active;
    if (!job) return;
    clearTimeout(this.jobDeadline);
    this.jobDeadline = undefined;
    this.notify(job, {
      state: ok ? "done" : "failed",
      message: ok
        ? "Hijack complete."
        : reason.startsWith(SAFETY_REASON_PREFIX)
          ? "The effect was stopped by the stream's safety filter."
          : `Hijack failed: ${reason}`,
    });
    this.jobCode.delete(job.jobId);
    this.emit.jobEnded?.(job, ok, reason);
    this.active = null;
    this.activeRemaining = 0;
    // Cooldown before the next job inits.
    const cooldownMs = this.getSettings().cooldownSec * 1000;
    this.cooldownUntil = Date.now() + cooldownMs;
    this.broadcast();
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => this.tryDispatch(), cooldownMs + 50);
  }

  private tryDispatch(): void {
    if (this.disposed || this.paused || this.active) return;
    if (this.routerState !== "IDLE") return;
    if (Date.now() < this.cooldownUntil) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    this.activeRemaining = job.durationSec;
    log("engine", `→dispatch ${job.jobId.slice(0, 8)} to router`);
    this.emit.dispatchJob(job);
    // Arm the backstop: if the router never reports done, free the queue.
    clearTimeout(this.jobDeadline);
    this.jobDeadline = setTimeout(
      () => this.onJobDeadline(job.jobId),
      job.durationSec * 1000 + JOB_DEADLINE_GRACE_MS,
    );
    // Update queued positions for everyone still waiting.
    this.queue.forEach((q, i) =>
      this.notify(q, { state: "queued", queuePosition: i + 1 }),
    );
    this.broadcast();
  }

  /** Remove queued (not yet dispatched) jobs matching `match`, ending each
   *  as failed — so hosts settle them (a paid one is refunded) and the job
   *  can never run afterwards. The active job is never touched. Returns how
   *  many were dropped. */
  dropQueued(match: (job: HijackJob) => boolean, reason: string): number {
    const dropped = this.queue.filter(match);
    if (dropped.length === 0) return 0;
    this.queue = this.queue.filter((j) => !match(j));
    for (const job of dropped) {
      warn("engine", `dropped queued ${job.jobId.slice(0, 8)}: ${reason}`);
      this.notify(job, { state: "failed", message: reason });
      this.jobCode.delete(job.jobId);
      this.emit.jobEnded?.(job, false, reason);
    }
    this.queue.forEach((q, i) => this.notify(q, { state: "queued", queuePosition: i + 1 }));
    this.broadcast();
    return dropped.length;
  }

  // ── Panic / pause ──────────────────────────────────────────────────────

  /** Cancel the in-flight job (if any) without pausing — for host-detected
   *  failures the router can't see, e.g. OBS restarting under a live job. The
   *  router tears down and reports job:done; the queue then moves on. */
  cancelActive(reason: string): boolean {
    if (!this.active) return false;
    warn("engine", `cancelling ${this.active.jobId.slice(0, 8)}: ${reason}`);
    this.emit.cancelJob(this.active.jobId, reason);
    return true;
  }

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
            prompt: publicLabel(this.active),
            remainingSec: this.activeRemaining,
          }
        : null,
      queueLength: this.queue.length,
      paused: this.paused,
      reviewPending: this.parked.size,
    };
  }

  private broadcast(): void {
    this.emit.status(this.snapshot());
  }

  private notify(job: HijackJob, status: Omit<SubmissionStatus, "code">): void {
    const code = this.jobCode.get(job.jobId);
    if (code) this.emit.submissionUpdate(code, status);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Stop timers and fail everything in flight. The active job (if any) is
   *  told to cancel — its router-side teardown still runs — and waiting
   *  submissions are notified so portals don't hang on "queued". */
  dispose(reason = "engine stopped"): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.jobDeadline);
    clearTimeout(this.cooldownTimer);
    if (this.active) {
      this.emit.cancelJob(this.active.jobId, reason);
      this.finishActive(false, reason);
      clearTimeout(this.cooldownTimer); // finishActive re-armed it
    }
    for (const job of this.queue.splice(0)) {
      this.notify(job, { state: "failed", message: `Hijack cancelled: ${reason}` });
      this.jobCode.delete(job.jobId);
      this.emit.jobEnded?.(job, false, reason);
    }
    for (const p of [...this.parked.values()]) {
      clearTimeout(p.timer);
      this.parked.delete(p.job.jobId);
      if (p.code) {
        this.emit.submissionUpdate(p.code, { state: "failed", message: `Hijack cancelled: ${reason}` });
      }
      this.emit.jobEnded?.(p.job, false, reason);
    }
    this.correlation.dispose();
  }
}

/** Stamp the streamer's safety policy onto a job (CONTENT-SAFETY S4/S6). */
function jobSafety(s: Settings, trusted: boolean, tipper: string | null): JobSafety {
  // The tip's display name is unverified free text that would go on stream;
  // displayName() cleans it or falls back to "a viewer". A banned tipper gets
  // no chip at all — their money buys the default preset, not airtime.
  const attribution =
    s.showAttribution && tipper && !isBanned(s, tipper) ? displayName(tipper, s.blocklistExtra) : null;
  return {
    outputGuard: s.outputGuard,
    trusted,
    attribution,
    aiLabel: s.showAiLabel,
  };
}

/** What every portal sees as "now playing": the preset's label, or a
 *  neutral phrase — a custom prompt is the viewer's text and isn't broadcast. */
function publicLabel(job: HijackJob): string {
  if (job.matchedBy === "manual") return "a streamer effect";
  return getPreset(job.presetId)?.label ?? "a custom effect";
}
