// WebSocket hub. Registers each page by role, relays RTC signaling + the
// viewer frame-gate message between router and viewer, and fans out status /
// submission updates. Knows nothing about the money logic — it just moves
// messages and reports router presence to the injected handlers.

import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AnyMsg,
  Role,
  ServerMsg,
  StatusSnapshot,
  SubmissionStatus,
} from "@rh/shared";
import { isRtcMsg } from "@rh/shared";
import { log, warn } from "./log.js";

interface SocketMeta {
  role: Role;
  code?: string; // portal only
}

export interface HubHandlers {
  onRouterState(
    state: import("@rh/shared").RouterState,
    jobId?: string,
    remainingSec?: number,
  ): void;
  onJobDone(jobId: string, ok: boolean, reason?: string): void;
  onRouterDisconnected(): void;
  getStatus(): StatusSnapshot;
}

export interface HubOptions {
  /** When set, hello as a privileged role (router/viewer) must carry this
   *  token or the socket is dropped. Portal stays public — it only receives
   *  broadcast status and its own submission updates. WS connections aren't
   *  CORS-gated, so this is what stops a hostile local page from registering
   *  as router (job theft) or viewer (stream hijack / fake frames-ok). */
  authToken?: string;
  /** Hosted control plane: drop local-plane messages (rtc:* signaling and
   *  viewer:frames-ok). Those never leave the streamer's machine — the
   *  Electron bridge relays them locally; anything arriving here is either a
   *  misconfigured client or an attack. */
  rejectLocalPlane?: boolean;
}

const PRIVILEGED_ROLES: ReadonlySet<Role> = new Set(["router", "viewer"]);

export class Hub {
  private wss: WebSocketServer | null = null;
  private meta = new WeakMap<WebSocket, SocketMeta>();
  private byRole: Record<Role, Set<WebSocket>> = {
    portal: new Set(),
    router: new Set(),
    viewer: new Set(),
  };

  /**
   * Two modes:
   *  · Local (server given) — the hub owns a WebSocketServer at /ws and
   *    processes hellos itself. The sidecar CLI and the Electron bridge.
   *  · Adopted (server null) — a multi-tenant front door owns the single
   *    WebSocketServer, reads the hello to pick the channel (and verify its
   *    JWT), then hands the socket over via adopt(). The hosted control
   *    plane: one Hub instance per ChannelRuntime.
   */
  constructor(
    server: Server | null,
    private handlers: HubHandlers,
    private opts: HubOptions = {},
  ) {
    if (server) {
      this.wss = new WebSocketServer({ server, path: "/ws" });
      this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    }
  }

  /** Adopted-mode entry: attach a socket whose hello the front door already
   *  read and authenticated. Processes the hello as if it arrived here. */
  adopt(ws: WebSocket, hello: AnyMsg): void {
    ws.on("message", (raw) => {
      let msg: AnyMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onMessage(ws, msg);
    });
    ws.on("close", () => this.onClose(ws));
    ws.on("error", () => this.onClose(ws));
    this.onMessage(ws, hello);
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    ws.on("message", (raw) => {
      let msg: AnyMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onMessage(ws, msg);
    });
    ws.on("close", () => this.onClose(ws));
    ws.on("error", () => this.onClose(ws));
  }

  private onMessage(ws: WebSocket, msg: AnyMsg): void {
    // Registration must come first.
    if (msg.t === "hello") {
      if (
        this.opts.authToken &&
        PRIVILEGED_ROLES.has(msg.role) &&
        msg.auth !== this.opts.authToken
      ) {
        warn("hub", `rejected unauthenticated ${msg.role} hello`);
        ws.close(4401, "auth required");
        return;
      }
      const meta: SocketMeta = { role: msg.role, code: msg.code };
      this.meta.set(ws, meta);
      this.byRole[msg.role].add(ws);
      log("hub", `+${msg.role}${msg.code ? ` (code ${msg.code})` : ""}`);
      this.sendTo(ws, { t: "welcome", role: msg.role });
      this.sendTo(ws, { t: "status", status: this.handlers.getStatus() });
      return;
    }

    const meta = this.meta.get(ws);
    if (!meta) return; // ignore pre-hello traffic

    // Relay RTC signaling + the frame-gate straight to the target role.
    if (isRtcMsg(msg) || msg.t === "viewer:frames-ok") {
      if (this.opts.rejectLocalPlane) {
        warn("hub", `dropped local-plane ${msg.t} on hosted hub`);
        return;
      }
      if (isRtcMsg(msg)) {
        this.forwardToRole(msg.target, {
          ...msg,
          from: meta.role,
        } as ServerMsg);
      } else {
        // Router listens for this to close the buffering gate.
        this.forwardToRole("router", msg as unknown as ServerMsg);
      }
      return;
    }

    // Control messages from the router.
    if (msg.t === "router:state") {
      this.handlers.onRouterState(msg.state, msg.jobId, msg.remainingSec);
      return;
    }
    if (msg.t === "job:done") {
      this.handlers.onJobDone(msg.jobId, msg.ok, msg.reason);
      return;
    }
  }

  private onClose(ws: WebSocket): void {
    const meta = this.meta.get(ws);
    if (!meta) return;
    this.byRole[meta.role].delete(ws);
    this.meta.delete(ws);
    log("hub", `-${meta.role}`);
    if (meta.role === "router" && this.byRole.router.size === 0) {
      this.handlers.onRouterDisconnected();
    }
  }

  // ── Outbound helpers ────────────────────────────────────────────────────

  private sendTo(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  forwardToRole(role: Role, msg: ServerMsg): void {
    const set = this.byRole[role];
    if (set.size === 0 && (msg.t === "job:start" || msg.t.startsWith("rtc"))) {
      warn("hub", `no ${role} connected for ${msg.t}`);
    }
    for (const ws of set) this.sendTo(ws, msg);
  }

  dispatchJob(job: import("@rh/shared").HijackJob): void {
    this.forwardToRole("router", { t: "job:start", job });
  }

  cancelJob(jobId: string, reason: string): void {
    this.forwardToRole("router", { t: "job:cancel", jobId, reason });
  }

  broadcastStatus(status: StatusSnapshot): void {
    const msg: ServerMsg = { t: "status", status };
    this.forwardToRole("portal", msg);
    this.forwardToRole("router", msg);
  }

  sendSubmissionUpdate(code: string, status: Omit<SubmissionStatus, "code">): void {
    const msg: ServerMsg = {
      t: "submission:update",
      status: { code, ...status },
    };
    for (const ws of this.byRole.portal) {
      const meta = this.meta.get(ws);
      if (meta?.code === code) this.sendTo(ws, msg);
    }
  }
}
