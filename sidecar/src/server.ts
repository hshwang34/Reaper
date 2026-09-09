// The local-server composition, extracted as a factory so TWO hosts can run
// the identical thing:
//   · sidecar/src/index.ts — the CLI demo rig (config from .env + settings.json)
//   · app/ (Electron main) — the packaged app's local bridge (config from
//     userData, keys from the app's settings UI)
//
// Everything host-specific arrives through LocalServerHost; nothing in here
// reads process.env or touches module-level singletons. The money path
// (engine ↔ hub) comes from @rh/core's createRuntime and the channel API from
// buildApiRouter — the same two calls the hosted control plane makes per
// channel. What's left here is what is genuinely local: OBS control, the
// loopback bind, static serving, and the install-token auth gate.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import express from "express";
import type { RouterState, Settings, StatusSnapshot } from "@rh/shared";
import {
  buildApiRouter,
  createRuntime,
  createStreamlabsAdapter,
  gatedMint,
  memoryLedger,
  mintClientToken,
  log,
  warn,
  type ApiContext,
  type Engine,
  type Hub,
  type TriggerAdapter,
} from "@rh/core";
import { ObsController } from "./obs.js";
import { createUploads } from "./uploads.js";

export interface LocalServerHost {
  /** Secrets + wiring the host resolved (from .env or the app's settings UI). */
  decartApiKey: string;
  streamlabsToken: string;
  obsWsUrl: string;
  obsWsPassword: string;
  /** Live settings access — host owns persistence. */
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  /** Where reference-image uploads land. */
  uploadsDir: string;
  /** Built web app to serve (absent/missing → dev mode, Vite provides pages). */
  webDist?: string;
  /** When set, privileged HTTP endpoints (mint/panic/OBS/settings/dev) and
   *  privileged WS roles (router/viewer) require this token. The Electron
   *  host sets a per-install token (preload → router; provisioned OBS URL →
   *  viewer); the CLI demo rig leaves it unset for the frictionless local
   *  loop. */
  authToken?: string;
  /** Cloud mode (Electron): mirror router lifecycle events upstream. Called
   *  alongside the local engine — the cloud engine owns the money logic, the
   *  local one just idles. */
  observer?: {
    onRouterState(state: RouterState, jobId?: string, remainingSec?: number): void;
    onJobDone(jobId: string, ok: boolean, reason?: string): void;
  };
  /** Cloud mode (Electron): delegate ek_ minting to the control plane (which
   *  job-gates and budget-caps it). When set, /api/token never touches a
   *  local key — there is none. */
  mintProxy?: (durationSec: number) => Promise<string>;
  /** Cloud mode (Electron): the money authority is remote, so panic and the
   *  status the tray/updater read must come from the control plane — the
   *  local engine never holds the active job in cloud mode, and pausing it
   *  would be a no-op that *looks* like a panic. */
  moneyProxy?: {
    togglePause(): Promise<boolean>;
    status(): StatusSnapshot;
  };
}

export interface LocalServer {
  server: Server;
  engine: Engine;
  hub: Hub;
  obs: ObsController;
  /** True when a real dct_ key is present (otherwise tokens mint as "MOCK"). */
  decartEnabled: boolean;
  /** Panic toggle against whichever engine owns the money path (local or
   *  cloud). Every panic surface — HTTP, hotkey, tray — goes through here. */
  togglePause(): Promise<boolean>;
  /** Status from whichever engine owns the money path. */
  status(): StatusSnapshot;
  /** Start listening + best-effort OBS connect + trigger adapters. */
  start(port: number): void;
  /** Stop triggers, dispose the engine, drop sockets, close the HTTP server. */
  stop(): Promise<void>;
}

export function createLocalServer(host: LocalServerHost): LocalServer {
  const decartEnabled = host.decartApiKey.startsWith("dct_");
  const obs = new ObsController(host.obsWsUrl, host.obsWsPassword);
  const { upload, publicUploadUrl, deleteUpload } = createUploads(host.uploadsDir);

  const app = express();
  // Deliberately NO cors() here: every legitimate consumer is same-origin
  // (dev pages reach us through the Vite proxy; in production/Electron we
  // serve the pages ourselves). A wildcard CORS header would instead invite
  // any website open in the streamer's browser to drive the money/panic/OBS
  // endpoints. Browser WS connections aren't CORS-gated, so the hub gates
  // privileged roles on the install token instead.
  app.use(express.json());
  // The HTTP server exists before the routes so the hub can attach /ws now;
  // Express resolves routes per request, so registration order below is free.
  const server = createServer(app);

  // ── The money path ───────────────────────────────────────────────────────
  const runtime = createRuntime({
    getSettings: host.getSettings,
    server,
    hub: { authToken: host.authToken },
    tag: "server",
    hooks: {
      onRouterState: (s, j, r) => host.observer?.onRouterState(s, j, r),
      onJobDone: (j, ok, r) => host.observer?.onJobDone(j, ok, r),
    },
  });
  const { engine, hub } = runtime;

  const togglePause = () =>
    host.moneyProxy ? host.moneyProxy.togglePause() : Promise.resolve(engine.togglePause());
  const status = () => host.moneyProxy?.status() ?? engine.snapshot();

  // One-per-job for this process; the hosted plane adds a persistent budget.
  const mintLedger = memoryLedger();
  const ctx: ApiContext = {
    runtime,
    updateSettings: host.updateSettings,
    decartEnabled,
    mint: (durationSec, origin) =>
      host.mintProxy
        ? host.mintProxy(durationSec) // the control plane gates it
        : gatedMint(engine, durationSec, (d) => mintClientToken(host.decartApiKey, d, origin), mintLedger),
    togglePause,
    imageUrl: (f) => publicUploadUrl(f.filename),
    discardUpload: (f) => deleteUpload(publicUploadUrl(f.filename)),
  };

  /** Gate for privileged endpoints. Public surface stays: health, config,
   *  presets, submissions, uploads, static pages. */
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!host.authToken) return next(); // CLI demo rig — ungated
    const provided = req.header("x-rh-auth") ?? String(req.query.auth ?? "");
    if (provided === host.authToken) return next();
    res.status(401).json({ error: "auth required" });
  };

  // ── HTTP API ─────────────────────────────────────────────────────────────

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, decartEnabled, streamlabs: Boolean(host.streamlabsToken) });
  });

  /** Router-only wiring (decart mode + OBS target). Localhost only. */
  app.get("/api/router-config", requireAuth, (_req, res) => {
    const s = host.getSettings();
    res.json({
      decartEnabled,
      obsScene: s.obsScene,
      obsSource: s.obsSource,
      obsConnected: obs.isConnected(),
    });
  });

  /** Toggle the OBS Browser Source that shows the AI viewer page. */
  app.post("/api/obs/toggle", requireAuth, async (req, res) => {
    const visible = Boolean(req.body?.visible);
    const s = host.getSettings();
    try {
      await obs.setVisible(s.obsScene, s.obsSource, visible);
      res.json({ ok: true, visible });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  // config · presets · submissions · settings · token · panic · dev/* —
  // the channel API shared with the hosted plane.
  app.use(
    "/api",
    buildApiRouter({ context: () => ctx, requireAuth, upload: upload.single("image") }),
  );

  // Serve uploaded reference images (also reachable via the Vite proxy).
  app.use("/uploads", express.static(host.uploadsDir));

  // ── Production static serving ────────────────────────────────────────────
  // When webDist exists the server serves the built app itself so the whole
  // product runs as ONE process on ONE port — no Vite, no proxy. This is the
  // exact composition the Electron app embeds. In dev the folder is usually
  // absent and the Vite proxy provides the same-origin glue instead.
  if (host.webDist && existsSync(host.webDist)) {
    const webDist = host.webDist;
    app.use(express.static(webDist));
    // SPA fallback: the web app uses browser-history routing (/portal,
    // /router, /viewer), so any GET that isn't an API/upload/asset path gets
    // index.html. Registered after every API route; /ws never reaches Express
    // (it's a WebSocket upgrade handled at the HTTP-server level by the Hub).
    app.use((req, res, next) => {
      if (req.method !== "GET") return next();
      if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) {
        return next();
      }
      res.sendFile(resolve(webDist, "index.html"));
    });
    log("server", "serving web/dist (production mode)");
  } else {
    log("server", "web/dist not found — dev mode, expecting the Vite server");
  }

  // ── Triggers ─────────────────────────────────────────────────────────────
  const triggers: TriggerAdapter[] = [];
  if (host.streamlabsToken) {
    triggers.push(createStreamlabsAdapter(host.streamlabsToken));
  }

  return {
    server,
    engine,
    hub,
    obs,
    decartEnabled,
    togglePause,
    status,
    start(port: number) {
      for (const t of triggers) {
        t.start((tip) => {
          const outcome = engine.onTip(tip);
          log(t.name, `$${tip.amount} from ${tip.username} → ${outcome}`);
        });
      }
      if (!host.streamlabsToken) {
        warn("server", "no Streamlabs token — only fake-tip trigger active");
      }
      // Loopback-only: this server holds panic/OBS/token-mint endpoints and
      // must never be reachable from the LAN. (Was previously an implicit
      // all-interfaces bind — flagged by security review.)
      server.listen(port, "127.0.0.1", () => {
        log("server", `local server on http://localhost:${port}`);
        log("server", `decart: ${decartEnabled ? "LIVE" : "MOCK (no key)"}`);
        // Best-effort OBS connect; fine if OBS isn't running yet.
        obs.ensureConnected().catch(() => {
          warn("server", "OBS not reachable yet — will retry on first toggle");
        });
      });
    },
    async stop() {
      for (const t of triggers) t.stop();
      runtime.dispose("server stopping");
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
