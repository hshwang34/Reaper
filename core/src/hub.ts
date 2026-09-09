// WebSocket hub. Registers each page by role, relays RTC signaling + the
// viewer frame-gate message between router and viewer, and fans out status /
// submission updates. Knows nothing about the money logic — it just moves
// messages and reports router presence to the injected handlers.
//
// Trust model: the wire is untrusted. `hello.role` is validated against the
// known roles before it touches any table, and every control message is
// gated on the role the socket registered as — a public portal socket must
// never be able to forge `router:state` (which can fail a paid live job) or
// `viewer:frames-ok` (which would unhide OBS on a black frame).

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AnyMsg,
  HijackJob,
  Role,
  RouterState,
  ServerMsg,
  StatusSnapshot,
  SubmissionStatus,
} from "@rh/shared";
import { isLocalPlaneMsg, isRtcMsg } from "@rh/shared";
import { log, warn } from "./log.js";

/** Constant-time compare for the install token: `!==` short-circuits on the
 *  first differing byte. Not practically exploitable on loopback, but free. */
function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface SocketMeta {
  role: Role;
  code?: string; // portal only
}

export interface HubHandlers {
  onRouterState(state: RouterState, jobId?: string, remainingSec?: number): void;
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

const ROLES: ReadonlySet<string> = new Set<Role>(["portal", "router", "viewer"]);
const PRIVILEGED_ROLES: ReadonlySet<Role> = new Set(["router", "viewer"]);

function isRole(v: unknown): v is Role {
  return typeof v === "string" && ROLES.has(v);
}

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
    this.attach(ws);
    this.onMessage(ws, hello);
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage): void {
    this.attach(ws);
  }

  private attach(ws: WebSocket): void {
    ws.on("message", (raw) => {
      let msg: AnyMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // A handler throwing must never take the process down with it — this
      // listener runs for unauthenticated, internet-facing traffic on the
      // hosted plane.
      try {
        this.onMessage(ws, msg);
      } catch (e) {
        warn("hub", `message handler threw: ${(e as Error).message}`);
      }
    });
    ws.on("close", () => this.onClose(ws));
    ws.on("error", () => this.onClose(ws));
  }

  private onMessage(ws: WebSocket, msg: AnyMsg): void {
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;

    // Registration must come first.
    if (msg.t === "hello") {
      if (!isRole(msg.role)) {
        warn("hub", `rejected hello with unknown role ${JSON.stringify(msg.role)}`);
        ws.close(4400, "unknown role");
        return;
      }
      if (
        this.opts.authToken &&
        PRIVILEGED_ROLES.has(msg.role) &&
        !tokenMatches(msg.auth, this.opts.authToken)
      ) {
        warn("hub", `rejected unauthenticated ${msg.role} hello`);
        ws.close(4401, "auth required");
        return;
      }
      const meta: SocketMeta = {
        role: msg.role,
        code: typeof msg.code === "string" ? msg.code : undefined,
      };
      this.meta.set(ws, meta);
      this.byRole[msg.role].add(ws);
      log("hub", `+${msg.role}${meta.code ? ` (code ${meta.code})` : ""}`);
      this.sendTo(ws, { t: "welcome", role: msg.role });
      this.sendTo(ws, { t: "status", status: this.handlers.getStatus() });
      return;
    }

    const meta = this.meta.get(ws);
    if (!meta) return; // ignore pre-hello traffic

    // ── Local plane: RTC signaling + the frame gate, relayed by role ──────
    if (isLocalPlaneMsg(msg)) {
      if (this.opts.rejectLocalPlane) {
        warn("hub", `dropped local-plane ${msg.t} on hosted hub`);
        return;
      }
      if (meta.role === "portal") {
        warn("hub", `dropped local-plane ${msg.t} from portal`);
        return;
      }
      if (isRtcMsg(msg)) {
        // Signaling only ever flows router ↔ viewer; a peer may not target
        // its own role (the type says PeerRole, the wire says anything), and
        // the recorded `from` is what we know, not what the sender claimed.
        const target: unknown = msg.target;
        if (target !== "router" && target !== "viewer") return;
        if (target === meta.role) return;
        this.forwardToRole(target, { ...msg, from: meta.role });
      } else if (meta.role === "viewer") {
        // Router listens for this to close the buffering gate.
        this.forwardToRole("router", msg);
      }
      return;
    }

    // ── Control plane: lifecycle reports, router only ─────────────────────
    if (msg.t === "router:state" || msg.t === "job:done") {
      if (meta.role !== "router") {
        warn("hub", `dropped ${msg.t} from ${meta.role}`);
        return;
      }
      if (msg.t === "router:state") {
        this.handlers.onRouterState(msg.state, msg.jobId, msg.remainingSec);
      } else {
        this.handlers.onJobDone(msg.jobId, msg.ok, msg.reason);
      }
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

  dispatchJob(job: HijackJob): void {
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

  /** Whether at least one router is registered right now. */
  get routerOnline(): boolean {
    return this.byRole.router.size > 0;
  }

  /** Close every registered socket (clients reconnect on their own) and the
   *  owned server, if any. Idempotent. Adopted-mode hubs close only the
   *  sockets they were handed — the front door's server is not theirs. */
  close(code = 1012, reason = "hub closing"): void {
    for (const role of Object.keys(this.byRole) as Role[]) {
      for (const ws of this.byRole[role]) {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      }
      this.byRole[role].clear();
    }
    this.wss?.close();
    this.wss = null;
  }
}
