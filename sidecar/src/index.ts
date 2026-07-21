// Sidecar entrypoint: HTTP API + WebSocket hub + trigger adapters, wired to the
// engine. Holds all secrets (Decart key, Streamlabs token); pages talk to it
// through the Vite proxy so everything is same-origin in the browser.

import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { getPreset, PRESETS } from "@rh/shared";
import {
  decartEnabled,
  env,
  getSettings,
  updateSettings,
  uploadsDir,
} from "./config.js";
import { log, warn } from "./log.js";
import { CorrelationStore } from "./correlation.js";
import { Engine, type EngineEmit } from "./engine.js";
import { Hub } from "./hub.js";
import { checkPrompt } from "./moderation.js";
import { upload, publicUploadUrl, deleteUpload } from "./uploads.js";
import { parseFakeTip } from "./triggers/fake.js";
import { createStreamlabsAdapter } from "./triggers/streamlabs.js";
import { obs } from "./obs.js";

const app = express();
app.use(cors());
app.use(express.json());

// ── Engine ↔ Hub wiring (late-bound to break the construction cycle) ───────
let hub: Hub;
const correlation = new CorrelationStore();
const engineEmit: EngineEmit = {
  dispatchJob: (job) => hub.dispatchJob(job),
  cancelJob: (jobId, reason) => hub.cancelJob(jobId, reason),
  status: (snap) => hub.broadcastStatus(snap),
  submissionUpdate: (code, status) => hub.sendSubmissionUpdate(code, status),
};
const engine = new Engine(correlation, engineEmit);

// ── HTTP API ───────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    decartEnabled,
    streamlabs: Boolean(env.streamlabsToken),
  });
});

/** Public config the portal needs (no secrets). */
app.get("/api/config", (_req, res) => {
  const s = getSettings();
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
  const s = getSettings();
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
    const { mintClientToken } = await import("./decart.js");
    const token = await mintClientToken(durationSec, origin);
    res.json({ token });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

/** Toggle the OBS Browser Source that shows the AI viewer page. */
app.post("/api/obs/toggle", async (req, res) => {
  const visible = Boolean(req.body?.visible);
  const s = getSettings();
  try {
    await obs.setVisible(s.obsScene, s.obsSource, visible);
    res.json({ ok: true, visible });
  } catch (e) {
    res.status(502).json({ ok: false, error: (e as Error).message });
  }
});

/** Full settings for the streamer control panel. */
app.get("/api/settings", (_req, res) => res.json(getSettings()));

app.post("/api/settings", (req, res) => {
  const next = updateSettings(req.body ?? {});
  engineEmit.status(engine.snapshot()); // reflect any wiring changes
  res.json(next);
});

app.get("/api/presets", (_req, res) => res.json(PRESETS));

/** Viewer submission: prompt + optional image, before tipping. */
app.post("/api/submissions", upload.single("image"), (req, res) => {
  const s = getSettings();
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
 *  payment/matching. Localhost-only by nature (sidecar binds locally). */
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
app.use("/uploads", express.static(uploadsDir));

// ── Server + Hub ─────────────────────────────────────────────────────────
const server = createServer(app);
hub = new Hub(server, {
  onRouterState: (state, jobId, rem) => engine.setRouterState(state, jobId, rem),
  onJobDone: (jobId, ok, reason) => engine.onJobDone(jobId, ok, reason),
  onRouterDisconnected: () => {
    warn("index", "router disconnected");
    engine.setRouterState("OFFLINE");
  },
  getStatus: () => engine.snapshot(),
});

// ── Triggers ───────────────────────────────────────────────────────────────
if (env.streamlabsToken) {
  const sl = createStreamlabsAdapter(env.streamlabsToken);
  sl.start((tip) => {
    const outcome = engine.onTip(tip);
    log("streamlabs", `$${tip.amount} from ${tip.username} → ${outcome}`);
  });
} else {
  warn("index", "STREAMLABS_SOCKET_TOKEN unset — only fake-tip trigger active");
}

server.listen(env.port, () => {
  log("index", `sidecar on http://localhost:${env.port}`);
  log("index", `decart: ${decartEnabled ? "LIVE" : "MOCK (no key)"}`);
  // Best-effort OBS connect; fine if OBS isn't running yet.
  obs.ensureConnected().catch(() => {
    warn("index", "OBS not reachable yet — will retry on first toggle");
  });
});
