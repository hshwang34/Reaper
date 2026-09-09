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

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import type { HelloMsg } from "@rh/shared";
import { buildApiRouter, log, warn } from "@rh/core";
import { channels, db, hijacks, submissionsLog } from "./db.js";
import { devAuthEnabled, env, repoRoot } from "./env.js";
import {
  APP_LOOPBACK_REDIRECT,
  exchangeTwitchCode,
  issueSession,
  newNonce,
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

/** Minimal cookie read (no cookie-parser dep for one value). */
function cookieValue(req: express.Request, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Start an OAuth flow with a browser-bound nonce (login-CSRF defense). */
async function startOauth(
  res: express.Response,
  payload: { app?: boolean; appState?: string },
): Promise<void> {
  const nonce = newNonce();
  res
    .cookie("rh_oauth_nonce", nonce, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
    })
    .redirect(twitchAuthorizeUrl(await signState({ ...payload, nonce })));
}

/** Browser sign-in (dashboard). */
app.get("/auth/twitch", (_req, res) => void startOauth(res, {}));

/** Desktop-app sign-in: same OAuth, loopback redirect at the end. The app's
 *  own state nonce is carried through so its loopback listener can bind the
 *  final callback to the sign-in it started (anti session-fixation). */
app.get("/auth/app", (req, res) => {
  const appState =
    typeof req.query.app_state === "string" ? req.query.app_state : undefined;
  void startOauth(res, { app: true, appState });
});

app.get("/auth/twitch/callback", async (req, res) => {
  const state = await readState(String(req.query.state ?? ""));
  if (!state) return res.status(400).send("bad state");
  // The state must carry the nonce this browser set when it STARTED the
  // flow — otherwise this is a spliced (CSRF'd) authorization response.
  const nonce = cookieValue(req, "rh_oauth_nonce");
  if (!nonce || state.nonce !== nonce) {
    return res.status(400).send("state/browser mismatch — restart sign-in");
  }
  res.clearCookie("rh_oauth_nonce");
  const user = await exchangeTwitchCode(String(req.query.code ?? ""));
  if (!user) return res.status(502).send("twitch exchange failed");
  upsertChannel(user.id, user.login, user.displayName);
  const tokens = await issueSession(user.id, user.login);
  if (state.app) {
    // Hand the session to the app's loopback listener. Query params (not a
    // fragment — fragments never reach an HTTP server) are safe here: the
    // redirect target is the app's own 127.0.0.1 listener, no intermediary
    // logs exist, and the refresh token is single-use anyway.
    const u = new URL(APP_LOOPBACK_REDIRECT);
    u.searchParams.set("refresh", tokens.refresh);
    u.searchParams.set("channel", tokens.channelId);
    u.searchParams.set("login", tokens.login);
    if (state.appState) u.searchParams.set("state", state.appState);
    res.redirect(u.toString());
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

// Per-channel upload dirs; same validation as the local rig. The stored
// extension comes from the ALLOWED mimetype map, never from the client's
// filename — otherwise an "image/png" upload named x.html becomes stored XSS
// when served same-origin from /uploads (security-review finding).
const ALLOWED_IMG = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const id = resolveChannelId(String(req.params.channel)) ?? "unknown";
      const dir = resolve(env.uploadsDir, id);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = ALLOWED_IMG.get(file.mimetype) ?? ".jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED_IMG.has(file.mimetype)),
});

// ── The channel API (shared with the local rig) ──────────────────────────
// config · presets · submissions (public) · settings · token · panic · dev/*
// (Bearer JWT). The router resolves :channel as id or login; the auth gate
// requires the JWT's subject to equal the id.
app.use(
  "/api/c/:channel",
  buildApiRouter({
    context: (req) => {
      const id = resolveChannelId(String(req.params.channel));
      const rt = id && getRuntime(id);
      if (!rt) return null;
      return {
        runtime: rt,
        updateSettings: rt.updateSettings,
        decartEnabled: Boolean(env.decartApiKey),
        mint: (durationSec) => rt.mint(durationSec),
        togglePause: () => Promise.resolve(rt.engine.togglePause()),
        imageUrl: (f) => `/uploads/${id}/${f.filename}`,
        discardUpload: (f) => rmSync(f.path, { force: true }),
        onSubmission: ({ code, presetId, hasImage }) => {
          db.insert(submissionsLog)
            .values({ channelId: id, code, presetId, hasImage: hasImage ? 1 : 0, createdAt: Date.now() })
            .run();
        },
      };
    },
    requireAuth: requireChannel,
    upload: upload.single("image"),
  }),
);

// ── Hosted-only streamer routes ───────────────────────────────────────────

/** Streamlabs pasted-token connect (OAuth flow lands when the app is approved).
 *  Swapped in place: rebuilding the runtime would orphan the router socket
 *  already adopted into its hub. */
app.post("/api/c/:channel/trigger/streamlabs", requireChannel, (req, res) => {
  const rt = getRuntime(String(req.params.channel));
  if (!rt) return res.status(404).json({ error: "unknown channel" });
  const token = String(req.body?.token ?? "").trim();
  rt.setStreamlabsToken(token);
  res.json({ ok: true, connected: Boolean(token) });
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
// One process hosts every channel's runtime: an unhandled error anywhere
// must never take all of them down. Log and carry on.
process.on("uncaughtException", (e) => warn("process", `uncaught: ${(e as Error).stack ?? e}`));
process.on("unhandledRejection", (e) => warn("process", `unhandled rejection: ${String(e)}`));

server.listen(env.port, () => {
  log("server", `control plane on ${env.publicUrl} (port ${env.port})`);
  log("server", `decart: ${env.decartApiKey ? "LIVE" : "MOCK"}`);
});
