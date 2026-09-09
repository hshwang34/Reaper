// The per-job state machine. One job at a time. Every exit path funnels through
// an idempotent teardown so we never leave OBS showing a dead source or a
// Decart session billing. See FEASIBILITY.md §3.
//
//   IDLE → AUTHORIZING → CONNECTING → BUFFERING → LIVE(D) → TEARDOWN → IDLE
//     mint fail / >10s connect / >8s no frames → ABORT (never unhide OBS)
//     any error / panic / watchdog(D+10) → TEARDOWN
//
// The buffering gate is the crux: OBS is unhidden ONLY after the viewer page
// reports N verified decoded frames (viewer:frames-ok), never on a timer or
// onloadeddata — a WebRTC stream can fire those while still black.
//
// Concurrency model: every async continuation (token mint, image fetch, Decart
// connect, OBS toggle) captures the job *generation* it started under and bails
// if a teardown has bumped it since. That is what makes teardown genuinely
// idempotent — a late callback from a job that was cancelled mid-await can't
// re-enter the machine, flap router:state, or (worst) unhide OBS after the
// session it belonged to was already torn down.
//
// Side effects go through MachinePorts (ports.ts) so all of the above is
// asserted by web/test/stateMachine.test.ts rather than promised in prose.

import type { HijackJob, RouterState } from "@rh/shared";
import { DEFAULT_TIMEOUTS, type MachinePorts, type MachineTimeouts } from "./ports.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MachineCallbacks {
  /** UI + engine notification of a state change. */
  onState: (state: RouterState, remainingSec?: number) => void;
  log: (line: string) => void;
  /** The Decart AI stream (or null on teardown) — for a direct local preview
   *  so the streamer can see the restyle independent of the OBS loopback. */
  onAiStream?: (stream: MediaStream | null) => void;
}

export class RouterMachine {
  private state: RouterState = "OFFLINE";
  private job: HijackJob | null = null;
  private camera: MediaStream | null = null;
  private tearingDown = false;
  private wentLive = false;
  private gotStream = false;
  /** Bumped on every job start and every teardown; see header comment. */
  private gen = 0;
  private t: MachineTimeouts;

  private liveInterval?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private bufferTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private ports: MachinePorts,
    private cb: MachineCallbacks,
    timeouts: Partial<MachineTimeouts> = {},
  ) {
    this.t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  getState(): RouterState {
    return this.state;
  }

  /** Acquire the camera once and hold it; then we're ready for jobs. */
  setCamera(stream: MediaStream): void {
    this.camera = stream;
    this.setState("IDLE");
  }

  hasCamera(): boolean {
    return this.camera !== null;
  }

  private setState(state: RouterState, remainingSec?: number): void {
    this.state = state;
    this.ports.send({
      t: "router:state",
      state,
      jobId: this.job?.jobId,
      remainingSec,
    });
    this.cb.onState(state, remainingSec);
  }

  /** True when a teardown has happened since generation `g` was captured. */
  private stale(g: number): boolean {
    return g !== this.gen;
  }

  // ── Job entry ────────────────────────────────────────────────────────────

  async runJob(job: HijackJob): Promise<void> {
    if (!this.camera) {
      this.cb.log("job arrived but camera not armed — ignoring");
      return;
    }
    if (this.job) {
      // Should be unreachable (the engine runs one job at a time with a
      // cooldown), but if it ever happens, fail it back explicitly rather
      // than leaving the engine to wait out its deadline backstop.
      this.cb.log("busy — rejecting overlapping job");
      this.ports.send({ t: "job:done", jobId: job.jobId, ok: false, reason: "router busy" });
      return;
    }
    const g = ++this.gen;
    this.job = job;
    this.tearingDown = false;
    this.wentLive = false;
    this.gotStream = false;
    this.cb.log(
      `job ${job.jobId.slice(0, 8)} — ${job.durationSec}s — "${job.prompt.slice(0, 48)}…"`,
    );

    // 1. AUTHORIZING — mint an ek_ token capped to this job's duration.
    this.setState("AUTHORIZING");
    let token: string;
    try {
      token = await this.ports.mintToken(job.durationSec);
    } catch (e) {
      if (this.stale(g)) return;
      return this.abort(`token mint failed: ${(e as Error).message}`);
    }
    if (this.stale(g)) return; // cancelled during await

    // 2. CONNECTING — open Decart (or MOCK passthrough).
    this.setState("CONNECTING");
    let imageBlob: Blob | null = null;
    if (job.imageUrl) {
      imageBlob = await this.ports.fetchImage(job.imageUrl);
      if (!imageBlob) this.cb.log("reference image fetch failed — continuing without it");
      if (this.stale(g)) return;
    }

    this.connectTimer = setTimeout(() => this.abort("connect timeout"), this.t.connectMs);
    try {
      await this.ports.decart.start({
        token,
        prompt: job.prompt,
        imageBlob,
        camera: this.camera,
        onRemoteStream: (stream) => {
          if (!this.stale(g)) void this.onRemoteStream(stream);
        },
      });
    } catch (e) {
      // A connect that fails *after* the timeout already aborted us is old
      // news — the DecartSession generation guard has cleaned it up.
      if (this.stale(g)) return;
      clearTimeout(this.connectTimer);
      return this.abort(`decart connect failed: ${(e as Error).message}`);
    }
  }

  private async onRemoteStream(stream: MediaStream): Promise<void> {
    if (this.gotStream || !this.job) return;
    this.gotStream = true;
    clearTimeout(this.connectTimer);
    const job = this.job;
    const g = this.gen;

    // Confirm the Decart stream actually carries a live video track, and mirror
    // it into the router's local AI preview so it's visible without OBS.
    const vt = stream.getVideoTracks()[0];
    this.cb.log(
      `decart stream received — video track: ${
        vt ? `${vt.readyState}${vt.muted ? " (muted/no frames yet)" : " (live)"}` : "NONE"
      }`,
    );
    this.cb.onAiStream?.(stream);

    // 3. BUFFERING — push to the viewer, wait for verified frames.
    this.setState("BUFFERING");
    await this.ports.sender.start(job.jobId, stream);
    if (this.stale(g)) return;
    this.bufferTimer = setTimeout(() => this.abort("no verified frames"), this.t.bufferMs);
  }

  /** Called by RouterPage when the viewer confirms N decoded frames. */
  onFramesOk(jobId: string): void {
    if (!this.job || this.job.jobId !== jobId) return;
    if (this.state !== "BUFFERING") return;
    clearTimeout(this.bufferTimer);
    void this.goLive(this.job);
  }

  private async goLive(job: HijackJob): Promise<void> {
    const g = this.gen;
    // 4. LIVE — unhide OBS, start the strict countdown.
    try {
      await this.ports.setObsVisible(true);
    } catch (e) {
      if (this.stale(g)) return;
      return this.abort(`obs toggle failed: ${(e as Error).message}`);
    }
    if (this.stale(g)) {
      // Panic/cancel landed while the unhide request was in flight. Teardown
      // already ran with wentLive=false (so it did NOT hide OBS) — re-hide
      // now or the overlay stays up on a source with no stream behind it.
      void this.ports.setObsVisible(false).catch(() => {});
      return;
    }
    this.wentLive = true;

    // Count down against an absolute wall-clock deadline, not a tick counter:
    // a backgrounded/occluded router tab throttles setInterval, so decrementing
    // once per tick would *stretch* the paid duration and over-bill the effect.
    // Deriving `remaining` from `Date.now()` keeps the displayed countdown
    // honest and tears down at the correct instant whenever a tick does fire.
    // The 250ms cadence makes teardown crisp when the tab is active; the
    // watchdog below bounds the worst case if ticks are starved entirely.
    const endAt = Date.now() + job.durationSec * 1000;
    let lastShown = job.durationSec;
    this.setState("LIVE", job.durationSec);
    this.liveInterval = setInterval(() => {
      if (Date.now() >= endAt) {
        void this.teardown(true, "completed");
        return;
      }
      const remaining = Math.max(1, Math.ceil((endAt - Date.now()) / 1000));
      if (remaining !== lastShown) {
        lastShown = remaining;
        this.setState("LIVE", remaining);
      }
    }, 250);

    // Watchdog backstop in case the interval is starved (heavy tab throttling).
    this.watchdog = setTimeout(
      () => this.teardown(true, "watchdog"),
      job.durationSec * 1000 + this.t.watchdogExtraMs,
    );
  }

  // ── Exit paths ─────────────────────────────────────────────────────────────

  /** Cancel from panic / hub job:cancel. */
  cancel(jobId: string, reason: string): void {
    if (this.job?.jobId === jobId) void this.teardown(false, reason);
  }

  private abort(reason: string): void {
    if (!this.job) return; // nothing to abort — a stale timer or callback
    this.cb.log(`ABORT: ${reason}`);
    void this.teardown(false, reason);
  }

  /** Idempotent teardown — safe to call from any state, any number of times.
   *  No-op when no job is in flight, so late callbacks can't flap state. */
  private async teardown(ok: boolean, reason: string): Promise<void> {
    if (this.tearingDown || !this.job) return;
    this.tearingDown = true;
    this.gen += 1; // invalidate every in-flight continuation of this job
    const job = this.job;

    clearInterval(this.liveInterval);
    clearTimeout(this.watchdog);
    clearTimeout(this.bufferTimer);
    clearTimeout(this.connectTimer);

    this.setState("TEARDOWN");

    // Cover the cut with the viewer's glitch-wipe, but only if something was
    // actually on screen (i.e. we reached LIVE). Hide OBS BEFORE dropping the
    // Decart session so the source never shows a dead stream.
    if (this.wentLive) {
      this.ports.sender.sendReset();
      await sleep(this.t.wipeMs);
      try {
        await this.ports.setObsVisible(false);
      } catch {
        /* best effort — never block teardown on OBS */
      }
    }

    this.ports.decart.disconnect();
    this.ports.sender.stop();
    this.cb.onAiStream?.(null);

    this.ports.send({ t: "job:done", jobId: job.jobId, ok, reason });
    this.cb.log(`teardown (${ok ? "ok" : "failed"}: ${reason})`);

    this.job = null;
    this.tearingDown = false;
    this.wentLive = false;
    this.gotStream = false;
    // If dispose() released the camera while we were mid-teardown, we are
    // OFFLINE, not IDLE — reporting IDLE would invite the engine to dispatch
    // the next job to a router that can't run it.
    this.setState(this.camera ? "IDLE" : "OFFLINE");
  }

  /** Full stop: release the camera (page unload / disarm). Resolves once the
   *  hide→disconnect sequence has finished. */
  dispose(): Promise<void> {
    const camera = this.camera;
    this.camera = null;
    if (this.job) {
      // teardown() ends in OFFLINE (camera is already null). Release the
      // camera only once the hide→disconnect sequence has finished.
      return this.teardown(false, "disposed").finally(() => {
        camera?.getTracks().forEach((t) => t.stop());
      });
    }
    camera?.getTracks().forEach((t) => t.stop());
    this.setState("OFFLINE");
    return Promise.resolve();
  }
}
