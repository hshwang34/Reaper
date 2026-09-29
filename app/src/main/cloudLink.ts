// Cloud link: the desktop app's single upstream connection to the hosted
// control plane (plan D1 — only cloud-plane messages traverse it; rtc
// signaling and frames-ok stay on this machine inside the local bridge).
//
//   downlink  job:start / job:cancel / status  → injected into the local hub
//             (straight to the router page; the LOCAL engine idles in cloud
//             mode — the cloud engine owns money logic)
//   uplink    router:state / job:done          → the channel's cloud engine
//
// Because the cloud engine owns the money path, it is also the only thing
// that can meaningfully pause or report status in cloud mode. This class
// therefore implements the local bridge's `moneyProxy`: panic goes up as an
// authed HTTP call, and the latest `status` downlink is mirrored so the tray
// and the updater's "never relaunch mid-hijack" guard read the real state.
//
// Sessions: a stored refresh token (userData/cloud.json) is rotated into
// 15-minute access JWTs on demand. Mid-job link loss is safe by construction:
// the router's watchdog + the token's maxSessionDuration bound cost with no
// cloud at all; job:done is queued for redelivery on reconnect so the ledger
// heals.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "electron";
import WebSocket from "ws";
import type { AnyMsg, HijackJob, RouterState, StatusSnapshot } from "@rh/shared";
import { log, warn, type Hub } from "@rh/core";

const cloudConfigPath = () => resolve(app.getPath("userData"), "cloud.json");

/** What the tray shows before the first status downlink (or while unlinked). */
const OFFLINE_STATUS: StatusSnapshot = {
  routerState: "OFFLINE",
  activeJob: null,
  queueLength: 0,
  paused: false,
};

const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

export interface CloudConfig {
  url: string; // e.g. https://app.example.com
  channelId: string;
  login: string;
  refresh: string;
}

export function loadCloudConfig(): CloudConfig | null {
  try {
    if (!existsSync(cloudConfigPath())) return null;
    const c = JSON.parse(readFileSync(cloudConfigPath(), "utf8"));
    if (c.url && c.channelId && c.refresh) return c as CloudConfig;
    return null;
  } catch {
    return null;
  }
}

export function saveCloudConfig(cfg: CloudConfig | null): void {
  writeFileSync(
    cloudConfigPath(),
    JSON.stringify(cfg ?? {}, null, 2),
    { mode: 0o600 },
  );
}

export class CloudLink {
  private ws: WebSocket | null = null;
  private access = "";
  private stopped = false;
  private reconnectAttempt = 0;
  private refreshing: Promise<"ok" | "revoked" | "transient"> | null = null;
  /** job:done events that failed to send — redelivered on reconnect. */
  private pendingDone: AnyMsg[] = [];
  /** Latest status the cloud engine broadcast for this channel. */
  private lastStatus: StatusSnapshot = OFFLINE_STATUS;

  constructor(
    private cfg: CloudConfig,
    /** The local bridge's hub — downlinked jobs are dispatched through it. */
    private localHub: Hub,
  ) {}

  /** Rotate the refresh token into a fresh access JWT (and persist the new
   *  refresh — they're single-use). "revoked" = the control plane refused the
   *  refresh token (sign in again); "transient" = network error / 5xx, worth
   *  retrying with backoff. */
  private refreshAccess(): Promise<"ok" | "revoked" | "transient"> {
    // Single-flight: refresh tokens are single-use, so a WS 4401 redial and
    // an authedPost 401 retry racing each other would spend the same token
    // twice — the loser gets "revoked" and the link stops for good.
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<"ok" | "revoked" | "transient"> {
    try {
      const res = await fetch(`${this.cfg.url}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh: this.cfg.refresh }),
      });
      if (res.status >= 500) {
        warn("cloud", `refresh failed (${res.status}) — will retry`);
        return "transient";
      }
      if (!res.ok) {
        warn("cloud", `refresh rejected (${res.status}) — sign in again`);
        return "revoked";
      }
      const tokens = (await res.json()) as { access: string; refresh: string };
      this.access = tokens.access;
      this.cfg.refresh = tokens.refresh;
      saveCloudConfig(this.cfg);
      return "ok";
    } catch (e) {
      warn("cloud", `refresh failed: ${(e as Error).message} — will retry`);
      return "transient";
    }
  }

  async start(): Promise<void> {
    await this.refreshThenConnect();
  }

  /** Refresh the access JWT, then dial. A transient refresh failure must
   *  re-enter the backoff loop — previously it just returned, so a control-
   *  plane blip at launch or at a 15-minute token rotation (close 4401)
   *  left the app permanently OFFLINE until relaunch. Only an explicit
   *  rejection of the refresh token stops the loop. */
  private async refreshThenConnect(): Promise<void> {
    if (this.stopped) return;
    const r = await this.refreshAccess();
    if (r === "ok") this.connect();
    else if (r === "transient") this.scheduleReconnect(true, "refresh failed");
  }

  private scheduleReconnect(needsRefresh: boolean, why: string): void {
    if (this.stopped) return;
    // Exponential backoff with jitter: a control-plane outage must not turn
    // every installed app into a synchronized 3-second hammer.
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt++,
    ) * (0.75 + Math.random() * 0.5);
    warn("cloud", `${why} — reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => {
      if (needsRefresh) void this.refreshThenConnect();
      else this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.stopped) return;
    const wsUrl = this.cfg.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      ws.send(
        JSON.stringify({
          t: "hello",
          role: "router",
          channel: this.cfg.channelId,
          auth: this.access,
        }),
      );
      log("cloud", `linked to ${this.cfg.url} as ${this.cfg.login}`);
      // Redeliver anything that raced a disconnect.
      for (const m of this.pendingDone.splice(0)) ws.send(JSON.stringify(m));
    });

    ws.on("message", (raw) => {
      let msg: AnyMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Downlink → local router page via the local hub.
      if (msg.t === "job:start") {
        log("cloud", `job ${msg.job.jobId.slice(0, 8)} ↓ dispatching locally`);
        this.localHub.dispatchJob(msg.job as HijackJob);
      } else if (msg.t === "job:cancel") {
        this.localHub.cancelJob(msg.jobId, msg.reason);
      } else if (msg.t === "status") {
        this.lastStatus = msg.status;
      }
    });

    ws.on("close", (code) => {
      this.lastStatus = OFFLINE_STATUS;
      // 4401 = access token expired mid-session; rotate before redial.
      this.scheduleReconnect(code === 4401, `link closed (${code})`);
    });
    ws.on("error", () => ws.close());
  }

  /** Uplink hooks — wired as the local composition's observer. */
  onRouterState(state: RouterState, jobId?: string, remainingSec?: number): void {
    this.send({ t: "router:state", state, jobId, remainingSec });
  }

  onJobDone(jobId: string, ok: boolean, reason?: string): void {
    const msg: AnyMsg = { t: "job:done", jobId, ok, reason };
    if (!this.send(msg)) this.pendingDone.push(msg); // redeliver on reconnect
  }

  // ── Money authority (the bridge's moneyProxy) ─────────────────────────────

  /** Mint via the control plane (job-gated + budget-capped server-side). */
  async mint(durationSec: number): Promise<string> {
    const body = await this.authedPost<{ token?: string }>("token", { durationSec });
    if (!body.token) throw new Error("mint returned no token");
    return body.token;
  }

  /** Panic toggle on the CLOUD engine — the one holding the active job. */
  async togglePause(): Promise<boolean> {
    const body = await this.authedPost<{ paused: boolean }>("panic", {});
    this.lastStatus = { ...this.lastStatus, paused: body.paused };
    return body.paused;
  }

  /** Last status the cloud engine broadcast (OFFLINE until linked). */
  status(): StatusSnapshot {
    return this.lastStatus;
  }

  /** Streamer-fired test hijack through the CLOUD engine (the wizard's
   *  "send yourself a test hijack" in cloud mode). */
  async devHijack(prompt: string, durationSec: number): Promise<string> {
    const body = await this.authedPost<{ outcome?: string }>("dev/hijack", {
      prompt,
      durationSec,
    });
    return body.outcome ?? "queued";
  }

  get login(): string {
    return this.cfg.login;
  }

  get portalUrl(): string {
    return `${this.cfg.url}/c/${encodeURIComponent(this.cfg.login)}`;
  }

  /** POST to this channel's authed API, rotating the access token once on
   *  401. Every control call shares this so the retry logic exists once. */
  private async authedPost<T>(path: string, payload: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(
        `${this.cfg.url}/api/c/${encodeURIComponent(this.cfg.channelId)}/${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.access}`,
          },
          body: JSON.stringify(payload),
        },
      );
      if (res.status === 401 && attempt === 0) {
        if ((await this.refreshAccess()) !== "ok") break;
        continue;
      }
      // A proxy in front of the control plane can answer 502/504 with HTML.
      const body = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    }
    throw new Error("cloud session expired — sign in again");
  }

  private send(m: AnyMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
