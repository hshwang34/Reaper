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

export class Hub {
  private wss: WebSocketServer;
  private meta = new WeakMap<WebSocket, SocketMeta>();
  private byRole: Record<Role, Set<WebSocket>> = {
    portal: new Set(),
    router: new Set(),
    viewer: new Set(),
  };

  constructor(server: Server, private handlers: HubHandlers) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
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
    if (isRtcMsg(msg)) {
      this.forwardToRole(msg.target, { ...msg, from: meta.role } as ServerMsg);
      return;
    }
    if (msg.t === "viewer:frames-ok") {
      // Router listens for this to close the buffering gate.
      this.forwardToRole("router", msg as unknown as ServerMsg);
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
