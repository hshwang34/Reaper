// Cloud link: the desktop app's single upstream connection to the hosted
// control plane (plan D1 — only cloud-plane messages traverse it; rtc
// signaling and frames-ok stay on this machine inside the local bridge).
//
//   downlink  job:start / job:cancel / status  → injected into the local hub
//             (straight to the router page; the LOCAL engine idles in cloud
//             mode — the cloud engine owns money logic)
//   uplink    router:state / job:done          → the channel's cloud engine
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
import type { AnyMsg, HijackJob, RouterState } from "@rh/shared";
import { log, warn, type Hub } from "@rh/core";

const cloudConfigPath = () => resolve(app.getPath("userData"), "cloud.json");

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
  /** job:done events that failed to send — redelivered on reconnect. */
  private pendingDone: AnyMsg[] = [];

  constructor(
    private cfg: CloudConfig,
    /** The local bridge's hub — downlinked jobs are dispatched through it. */
    private localHub: Hub,
  ) {}

  /** Rotate the refresh token into a fresh access JWT (and persist the new
   *  refresh — they're single-use). */
  private async refreshAccess(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.url}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh: this.cfg.refresh }),
      });
      if (!res.ok) {
        warn("cloud", `refresh rejected (${res.status}) — sign in again`);
        return false;
      }
      const tokens = (await res.json()) as { access: string; refresh: string };
      this.access = tokens.access;
      this.cfg.refresh = tokens.refresh;
      saveCloudConfig(this.cfg);
      return true;
    } catch (e) {
      warn("cloud", `refresh failed: ${(e as Error).message}`);
      return false;
    }
  }

  async start(): Promise<void> {
    if (!(await this.refreshAccess())) return;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const wsUrl = this.cfg.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
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
      }
      // status broadcasts are informational here (tray reads local state).
    });

    ws.on("close", (code) => {
      if (this.stopped) return;
      warn("cloud", `link closed (${code}) — reconnecting in 3s`);
      setTimeout(() => {
        // 4401 = access token expired mid-session; rotate before redial.
        void (code === 4401 ? this.refreshAccess() : Promise.resolve(true)).then(
          (okay) => okay && this.connect(),
        );
      }, 3000);
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

  /** Mint via the control plane (job-gated + budget-capped server-side). */
  async mint(durationSec: number): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(
        `${this.cfg.url}/api/c/${encodeURIComponent(this.cfg.channelId)}/token`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.access}`,
          },
          body: JSON.stringify({ durationSec }),
        },
      );
      if (res.status === 401 && attempt === 0) {
        if (!(await this.refreshAccess())) break;
        continue;
      }
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        throw new Error(body.error ?? `mint failed (${res.status})`);
      }
      return body.token;
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
