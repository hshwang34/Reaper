// The local-server composition, extracted as a factory so TWO hosts can run
// the identical thing:
//   · sidecar/src/index.ts — the CLI demo rig (config from .env + settings.json)
//   · app/ (Electron main) — the packaged app's local bridge (config from
//     userData, keys from the app's settings UI)
//
// Everything host-specific arrives through LocalServerHost; nothing in here
// reads process.env or touches module-level singletons. The returned handles
// (engine, hub, obs) let the Electron host wire tray status, the panic
// hotkey, and OBS provisioning without going through HTTP.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { getPreset, PRESETS, type Settings } from "@rh/shared";
import {
  CorrelationStore,
  Engine,
  Hub,
  checkPrompt,
  createStreamlabsAdapter,
  parseFakeTip,
  log,
  warn,
  type EngineEmit,
  type TriggerAdapter,
} from "@rh/core";
import { mintClientToken } from "./decart.js";
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
}

export interface LocalServer {
  server: Server;
  engine: Engine;
  hub: Hub;
  obs: ObsController;
  /** True when a real dct_ key is present (otherwise tokens mint as "MOCK"). */
  decartEnabled: boolean;
  /** Start listening + best-effort OBS connect + trigger adapters. */
  start(port: number): void;
  /** Stop triggers and close the HTTP server (Electron quit path). */
  stop(): Promise<void>;
}

export function createLocalServer(host: LocalServerHost): LocalServer {
  const decartEnabled = host.decartApiKey.startsWith("dct_");
  const obs = new ObsController(host.obsWsUrl, host.obsWsPassword);
  const { upload, publicUploadUrl, deleteUpload } = createUploads(
    host.uploadsDir,
  );

  const app = express();
  // Deliberately NO cors() here: every legitimate consumer is same-origin
  // (dev pages reach us through the Vite proxy; in production/Electron we
  // serve the pages ourselves). A wildcard CORS header would instead invite
  // any website open in the streamer's browser to drive the money/panic/OBS
  // endpoints. Browser WS connections aren't CORS-gated, so role auth on the
  // hub (per-boot token) is the remaining hardening — tracked for M2 polish.
  app.use(express.json());

  // ── Engine ↔ Hub wiring (late-bound to break the construction cycle) ─────
  let hub: Hub;
  const correlation = new CorrelationStore();
  const engineEmit: EngineEmit = {
    dispatchJob: (job) => hub.dispatchJob(job),
    cancelJob: (jobId, reason) => hub.cancelJob(jobId, reason),
    status: (snap) => hub.broadcastStatus(snap),
    submissionUpdate: (code, status) => hub.sendSubmissionUpdate(code, status),
  };
  const engine = new Engine(correlation, engineEmit, host.getSettings);

  // ── HTTP API ─────────────────────────────────────────────────────────────

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      decartEnabled,
      streamlabs: Boolean(host.streamlabsToken),
    });
  });

  /** Public config the portal needs (no secrets). */
  app.get("/api/config", (_req, res) => {
    const s = host.getSettings();
    const enabled = PRESETS.filter((p) => s.enabledPresetIds.includes(p.id));
    res.json({
      presets: enabled,
      allowCustomPrompts: s.allowCustomPrompts,
      minTipUSD: s.minTipUSD,
      maxDurationSec: s.maxDurationSec,
      secondsPerUSD: s.secondsPerUSD,
      decartEnabled,
    });
  });

  /** Router-only wiring (decart mode + OBS target). Localhost only. */
  app.get("/api/router-config", (_req, res) => {
    const s = host.getSettings();
    res.json({
      decartEnabled,
      obsScene: s.obsScene,
      obsSource: s.obsSource,
      obsConnected: obs.isConnected(),
    });
  });

  /** Mint a per-job Decart client token (ek_) capped to the paid duration. */
  app.post("/api/token", async (req, res) => {
    const durationSec = Number(req.body?.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return res.status(400).json({ error: "durationSec required" });
    }
    const origin = String(req.body?.origin ?? "");
    try {
      const token = await mintClientToken(
        host.decartApiKey,
        durationSec,
        origin,
      );
      res.json({ token });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  /** Toggle the OBS Browser Source that shows the AI viewer page. */
  app.post("/api/obs/toggle", async (req, res) => {
    const visible = Boolean(req.body?.visible);
    const s = host.getSettings();
    try {
      await obs.setVisible(s.obsScene, s.obsSource, visible);
      res.json({ ok: true, visible });
    } catch (e) {
      res.status(502).json({ ok: false, error: (e as Error).message });
    }
  });

  /** Full settings for the streamer control panel. */
  app.get("/api/settings", (_req, res) => res.json(host.getSettings()));

  app.post("/api/settings", (req, res) => {
    const next = host.updateSettings(req.body ?? {});
    engineEmit.status(engine.snapshot()); // reflect any wiring changes
    res.json(next);
  });

  app.get("/api/presets", (_req, res) => res.json(PRESETS));

  /** Viewer submission: prompt + optional image, before tipping. */
  app.post("/api/submissions", upload.single("image"), (req, res) => {
    const s = host.getSettings();
    const presetId = String(req.body.presetId ?? "").trim() || null;
    const customPrompt = String(req.body.prompt ?? "").trim();
    const tipperName = String(req.body.tipperName ?? "").trim() || null;
    const imageUrl = req.file ? publicUploadUrl(req.file.filename) : null;

    const fail = (code: number, reason: string) => {
      deleteUpload(imageUrl);
      res.status(code).json({ error: reason });
    };

    let finalPrompt: string;
    let finalPresetId: string | null;

    if (presetId) {
      const preset = getPreset(presetId);
      if (!preset) return fail(400, "unknown preset");
      if (!s.enabledPresetIds.includes(presetId)) {
        return fail(403, "preset not enabled by streamer");
      }
      finalPrompt = preset.prompt; // resolved server-side; client can't spoof it
      finalPresetId = preset.id;
    } else if (customPrompt) {
      if (!s.allowCustomPrompts) {
        return fail(403, "custom prompts are disabled by the streamer");
      }
      const mod = checkPrompt(customPrompt, s.blocklistExtra);
      if (!mod.ok) return fail(422, mod.reason ?? "prompt rejected");
      finalPrompt = customPrompt;
      finalPresetId = null;
    } else {
      return fail(400, "provide a preset or a custom prompt");
    }

    const sub = correlation.add({
      prompt: finalPrompt,
      presetId: finalPresetId,
      tipperName,
      imageUrl,
    });
    res.json({ code: sub.code, expiresAt: sub.expiresAt });
  });

  /** Streamer panic toggle (also bound to a hotkey on the router page). */
  app.post("/api/panic", (_req, res) => {
    const paused = engine.togglePause();
    res.json({ paused });
  });

  /** Streamer console trigger — fire a hijack directly from the router page.
   *  Runs the identical job pipeline (queue → state machine → OBS), minus
   *  payment/matching. Localhost-only by nature (server binds locally). */
  app.post("/api/dev/hijack", (req, res) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    const durationSec = Number(req.body?.durationSec ?? 15);
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return res.status(400).json({ error: "durationSec must be positive" });
    }
    const outcome = engine.manual(prompt, durationSec);
    log("manual", `${durationSec}s "${prompt.slice(0, 40)}…" → ${outcome}`);
    res.json({ ok: true, outcome });
  });

  /** Dev trigger — fakes a tip so the whole path runs without Streamlabs. */
  app.post("/api/dev/fake-tip", (req, res) => {
    const parsed = parseFakeTip(req.body);
    if ("error" in parsed) return res.status(400).json(parsed);
    const outcome = engine.onTip(parsed);
    log("fake-tip", `$${parsed.amount} "${parsed.message}" → ${outcome}`);
    res.json({ ok: true, outcome });
  });

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

  // ── Server + Hub ─────────────────────────────────────────────────────────
  const server = createServer(app);
  hub = new Hub(server, {
    onRouterState: (state, jobId, rem) =>
      engine.setRouterState(state, jobId, rem),
    onJobDone: (jobId, ok, reason) => engine.onJobDone(jobId, ok, reason),
    onRouterDisconnected: () => {
      warn("server", "router disconnected");
      engine.setRouterState("OFFLINE");
    },
    getStatus: () => engine.snapshot(),
  });

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
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
