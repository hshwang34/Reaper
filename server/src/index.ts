// Control-plane entrypoint: auth routes, per-channel HTTP API, the
// multi-tenant WS front door, uploads, and the hosted portal.
//
// URL scheme (channel = Twitch user id; login-based vanity URLs resolve):
//   /auth/twitch, /auth/twitch/callback, /auth/app, /auth/refresh, /auth/dev
//   /api/c/:channel/config|submissions      — public (viewers)
//   /api/c/:channel/settings|token|panic|dev/* — Bearer JWT (streamer/app)
//   /ws  (hello carries {channel, auth})    — portal public; router JWT;
//                                             viewer rejected (local-plane)
//   /c/:login                                — hosted viewer portal (SPA)
//   /uploads/:channel/*                      — reference images

import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import { getPreset, PRESETS, type HelloMsg } from "@rh/shared";
import { checkPrompt, log, parseFakeTip, warn } from "@rh/core";
import { channels, db, hijacks, submissionsLog } from "./db.js";
import { devAuthEnabled, env, repoRoot } from "./env.js";
import {
  APP_LOOPBACK_REDIRECT,
  exchangeTwitchCode,
  issueSession,
  readState,
  refreshSession,
  requireChannel,
  signState,
  twitchAuthorizeUrl,
  upsertChannel,
  verifyAccess,
} from "./auth.js";
import { channelExists, getRuntime } from "./channels.js";

const app = express();
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, devAuth: devAuthEnabled, decart: Boolean(env.decartApiKey) });
});

// ── Auth ──────────────────────────────────────────────────────────────────

/** Browser sign-in (dashboard). */
app.get("/auth/twitch", async (_req, res) => {
  res.redirect(twitchAuthorizeUrl(await signState({})));
});

/** Desktop-app sign-in: same OAuth, loopback redirect at the end. */
app.get("/auth/app", async (_req, res) => {
  res.redirect(twitchAuthorizeUrl(await signState({ app: true })));
});

app.get("/auth/twitch/callback", async (req, res) => {
  const state = await readState(String(req.query.state ?? ""));
  if (!state) return res.status(400).send("bad state");
  const user = await exchangeTwitchCode(String(req.query.code ?? ""));
  if (!user) return res.status(502).send("twitch exchange failed");
  upsertChannel(user.id, user.login, user.displayName);
  const tokens = await issueSession(user.id, user.login);
  if (state.app) {
    // Hand the session to the app's loopback listener via fragment (never
    // logged in server access logs the way query strings are).
    const u = new URL(APP_LOOPBACK_REDIRECT);
    res.redirect(
      `${u}#access=${encodeURIComponent(tokens.access)}&refresh=${encodeURIComponent(tokens.refresh)}&channel=${tokens.channelId}&login=${tokens.login}`,
    );
    return;
  }
  res
    .cookie("rh_session", tokens.access, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 15 * 60 * 1000,
    })
    .redirect(`/dashboard#refresh=${encodeURIComponent(tokens.refresh)}`);
});

app.post("/auth/refresh", async (req, res) => {
  const refreshed = await refreshSession(String(req.body?.refresh ?? ""));
  if (!refreshed) return res.status(401).json({ error: "invalid refresh" });
  res.json(refreshed);
});

/** DEV AUTH — only when no Twitch app is configured (env warns loudly). */
if (devAuthEnabled) {
  app.post("/auth/dev", async (req, res) => {
    const login = String(req.body?.login ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_]{2,25}$/.test(login)) {
      return res.status(400).json({ error: "invalid login" });
    }
    const id = `dev:${login}`;
    upsertChannel(id, login, login);
    res.json(await issueSession(id, login));
  });
}

// ── Per-channel public API (viewers) ──────────────────────────────────────

/** Resolve :channel as id or login (vanity portal URLs use logins). */
function resolveChannelId(param: string): string | null {
  if (channelExists(param)) return param;
  const byLogin = db
    .select()
    .from(channels)
    .where(eq(channels.login, param.toLowerCase()))
    .get();
  return byLogin?.id ?? null;
}

app.get("/api/c/:channel/config", (req, res) => {
  const id = resolveChannelId(String(req.params.channel));
  const rt = id && getRuntime(id);
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  const s = rt.getSettings();
  res.json({
    presets: PRESETS.filter((p) => s.enabledPresetIds.includes(p.id)),
    allowCustomPrompts: s.allowCustomPrompts,
    minTipUSD: s.minTipUSD,
    maxDurationSec: s.maxDurationSec,
    secondsPerUSD: s.secondsPerUSD,
    decartEnabled: Boolean(env.decartApiKey),
  });
});

// Per-channel upload dirs; same validation as the local rig.
const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const id = resolveChannelId(String(req.params.channel)) ?? "unknown";
      const dir = resolve(env.uploadsDir, id);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase() || ".jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_IMG.has(file.mimetype)),
});

app.post("/api/c/:channel/submissions", upload.single("image"), (req, res) => {
  const id = resolveChannelId(String(req.params.channel));
  const rt = id && getRuntime(id);
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  const s = rt.getSettings();
  const presetId = String(req.body.presetId ?? "").trim() || null;
  const customPrompt = String(req.body.prompt ?? "").trim();
  const tipperName = String(req.body.tipperName ?? "").trim() || null;
  const imageUrl = req.file ? `/uploads/${id}/${req.file.filename}` : null;

  let finalPrompt: string;
  let finalPresetId: string | null;
  if (presetId) {
    const preset = getPreset(presetId);
    if (!preset) return res.status(400).json({ error: "unknown preset" });
    if (!s.enabledPresetIds.includes(presetId)) {
      return res.status(403).json({ error: "preset not enabled" });
    }
    finalPrompt = preset.prompt;
    finalPresetId = preset.id;
  } else if (customPrompt) {
    if (!s.allowCustomPrompts) {
      return res.status(403).json({ error: "custom prompts disabled" });
    }
    const mod = checkPrompt(customPrompt, s.blocklistExtra);
    if (!mod.ok) return res.status(422).json({ error: mod.reason });
    finalPrompt = customPrompt;
    finalPresetId = null;
  } else {
    return res.status(400).json({ error: "provide a preset or a prompt" });
  }

  const sub = rt.correlation.add({
    prompt: finalPrompt,
    presetId: finalPresetId,
    tipperName,
    imageUrl,
  });
  db.insert(submissionsLog)
    .values({
      channelId: id,
      code: sub.code,
      presetId: finalPresetId,
      hasImage: imageUrl ? 1 : 0,
      createdAt: Date.now(),
    })
    .run();
  res.json({ code: sub.code, expiresAt: sub.expiresAt });
});

// ── Per-channel authed API (streamer dashboard / desktop app) ─────────────

app.get("/api/c/:channel/settings", requireChannel, (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  res.json(rt.getSettings());
});

app.post("/api/c/:channel/settings", requireChannel, (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  res.json(rt.updateSettings(req.body ?? {}));
});

/** Streamlabs pasted-token connect (OAuth flow lands when the app is approved). */
app.post("/api/c/:channel/trigger/streamlabs", requireChannel, (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  db.update(channels)
    .set({ streamlabsToken: token })
    .where(eq(channels.id, String(req.params.channel)))
    .run();
  // Restart the runtime so the trigger picks the token up.
  getRuntime(String(req.params.channel))?.stop();
  getRuntime(String(req.params.channel));
  res.json({ ok: true, connected: Boolean(token) });
});

app.post("/api/c/:channel/token", requireChannel, async (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  const durationSec = Number(req.body?.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return res.status(400).json({ error: "durationSec required" });
  }
  try {
    res.json({ token: await rt.mint(durationSec) });
  } catch (e) {
    res.status(403).json({ error: (e as Error).message });
  }
});

app.post("/api/c/:channel/panic", requireChannel, (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  res.json({ paused: rt.engine.togglePause() });
});

app.post("/api/c/:channel/dev/fake-tip", requireChannel, (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  const parsed = parseFakeTip(req.body);
  if ("error" in parsed) return res.status(400).json(parsed);
  res.json({ ok: true, outcome: rt.onTip(parsed) });
});

app.post("/api/c/:channel/dev/hijack", requireChannel, (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  const prompt = String(req.body?.prompt ?? "").trim();
  const durationSec = Number(req.body?.durationSec ?? 15);
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  res.json({ ok: true, outcome: rt.engine.manual(prompt, durationSec) });
});

/** Ledger view for the dashboard. */
app.get("/api/c/:channel/ledger", requireChannel, (req, res) => {
  const rows = db
    .select()
    .from(hijacks)
    .where(eq(hijacks.channelId, String(req.params.channel)))
    .all()
    .slice(-100)
    .reverse();
  res.json(rows);
});

// ── Uploads + hosted portal ───────────────────────────────────────────────

if (!existsSync(env.uploadsDir)) mkdirSync(env.uploadsDir, { recursive: true });
app.use("/uploads", express.static(env.uploadsDir));

const webDist = resolve(repoRoot, "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (
      req.path.startsWith("/api") ||
      req.path.startsWith("/auth") ||
      req.path.startsWith("/uploads")
    ) {
      return next();
    }
    res.sendFile(resolve(webDist, "index.html"));
  });
  log("server", "serving hosted portal from web/dist");
} else {
  warn("server", "web/dist missing — run `npm run build` for the hosted portal");
}

// ── Multi-tenant WS front door ────────────────────────────────────────────
// One WebSocketServer; the first message must be a hello carrying `channel`.
// Rules: portal is public; router requires a channel-matching JWT (it's the
// desktop app's cloud link); viewer is refused outright — the viewer page is
// local-plane and never talks to the cloud.

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.once("message", (raw) => {
    void (async () => {
      let hello: HelloMsg;
      try {
        hello = JSON.parse(raw.toString());
      } catch {
        ws.close(4400, "bad hello");
        return;
      }
      if (hello.t !== "hello" || !hello.channel) {
        ws.close(4400, "hello with channel required");
        return;
      }
      const id = resolveChannelId(hello.channel);
      const rt = id && getRuntime(id);
      if (!rt) {
        ws.close(4404, "unknown channel");
        return;
      }
      if (hello.role === "viewer") {
        ws.close(4403, "viewer is local-plane");
        return;
      }
      if (hello.role === "router") {
        const sub = hello.auth ? await verifyAccess(hello.auth) : null;
        if (sub !== id) {
          warn("front-door", `rejected router hello for ${hello.channel}`);
          ws.close(4401, "auth required");
          return;
        }
      }
      rt.hub.adopt(ws, { ...hello, auth: undefined });
    })();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(env.port, () => {
  log("server", `control plane on ${env.publicUrl} (port ${env.port})`);
  log("server", `decart: ${env.decartApiKey ? "LIVE" : "MOCK"}`);
});
