// Accounts + sessions.
//
// One OAuth does everything (COMMERCIALIZATION §2): "Sign in with Twitch"
// auto-provisions the channel row on first login. Sessions are our own JWTs:
// a 15-minute access token + a rotating 30-day refresh token (stored hashed).
// The Electron app authenticates with the same flow via a loopback redirect
// (system browser → http://127.0.0.1:17716/callback) — no embedded webview.
//
// DEV AUTH: with no Twitch app registered (env), /auth/dev?login=<name>
// creates a local fake channel and returns tokens. This keeps the entire
// control plane verifiable while the real OAuth app application is pending.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS } from "@rh/shared";
import { log, warn } from "@rh/core";
import { db, channels, refreshTokens } from "./db.js";
import { devAuthEnabled, env } from "./env.js";

const secret = new TextEncoder().encode(env.jwtSecret);
const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

/** Loopback redirect target the desktop app listens on during sign-in. */
export const APP_LOOPBACK_REDIRECT = "http://127.0.0.1:17716/callback";

export interface SessionTokens {
  access: string;
  refresh: string;
  channelId: string;
  login: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function issueSession(
  channelId: string,
  login: string,
): Promise<SessionTokens> {
  const access = await new SignJWT({ login })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(channelId)
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .setIssuedAt()
    .sign(secret);
  const refresh = `${randomUUID()}.${randomBytes(24).toString("hex")}`;
  db.insert(refreshTokens)
    .values({
      id: refresh.split(".")[0],
      channelId,
      tokenHash: sha256(refresh),
      expiresAt: Date.now() + REFRESH_TTL_MS,
    })
    .run();
  return { access, refresh, channelId, login };
}

/** Rotate: burn the presented refresh token, issue a fresh pair. */
export async function refreshSession(
  refresh: string,
): Promise<SessionTokens | null> {
  const id = refresh.split(".")[0];
  const row = db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.id, id))
    .get();
  if (!row || row.tokenHash !== sha256(refresh) || row.expiresAt < Date.now()) {
    return null;
  }
  db.delete(refreshTokens).where(eq(refreshTokens.id, id)).run();
  const ch = db
    .select()
    .from(channels)
    .where(eq(channels.id, row.channelId))
    .get();
  if (!ch || ch.suspended) return null;
  return issueSession(ch.id, ch.login);
}

/** Verify an access JWT → channelId, or null. */
export async function verifyAccess(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** Express guard: Bearer token must belong to req.params.channel. */
export const requireChannel: RequestHandler = async (req, res, next) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const sub = token ? await verifyAccess(token) : null;
  if (!sub || sub !== String(req.params.channel)) {
    res.status(401).json({ error: "auth required" });
    return;
  }
  next();
};

export function upsertChannel(
  id: string,
  login: string,
  displayName: string,
): void {
  const existing = db.select().from(channels).where(eq(channels.id, id)).get();
  if (existing) return;
  db.insert(channels)
    .values({
      id,
      login,
      displayName,
      settingsJson: JSON.stringify(DEFAULT_SETTINGS),
      createdAt: Date.now(),
    })
    .run();
  log("auth", `provisioned channel ${login} (${id})`);
}

// ── Twitch OAuth ──────────────────────────────────────────────────────────

export function twitchAuthorizeUrl(stateToken: string): string {
  const u = new URL("https://id.twitch.tv/oauth2/authorize");
  u.searchParams.set("client_id", env.twitchClientId);
  u.searchParams.set("redirect_uri", `${env.publicUrl}/auth/twitch/callback`);
  u.searchParams.set("response_type", "code");
  // bits:read now so EventSub channel.cheer works without re-consent later.
  u.searchParams.set("scope", "bits:read");
  u.searchParams.set("state", stateToken);
  return u.toString();
}

/** Signed state → survives the round trip without server-side storage. The
 *  nonce binds the state to the browser that STARTED the flow (double-submit
 *  cookie): the callback only accepts a state whose nonce matches the
 *  rh_oauth_nonce cookie, so an attacker can't splice their own authorization
 *  response into a victim's session (login CSRF — security-review finding). */
export async function signState(payload: {
  app?: boolean;
  nonce: string;
}): Promise<string> {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(secret);
}

export async function readState(
  state: string,
): Promise<{ app?: boolean; nonce?: string } | null> {
  try {
    const { payload } = await jwtVerify(state, secret);
    return payload as { app?: boolean; nonce?: string };
  } catch {
    return null;
  }
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export async function exchangeTwitchCode(
  code: string,
): Promise<{ id: string; login: string; displayName: string } | null> {
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.twitchClientId,
      client_secret: env.twitchClientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${env.publicUrl}/auth/twitch/callback`,
    }),
  });
  if (!tokenRes.ok) {
    warn("auth", `twitch token exchange failed: ${tokenRes.status}`);
    return null;
  }
  const tok = (await tokenRes.json()) as { access_token: string };
  const userRes = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      "client-id": env.twitchClientId,
    },
  });
  if (!userRes.ok) return null;
  const body = (await userRes.json()) as {
    data: { id: string; login: string; display_name: string }[];
  };
  const u = body.data[0];
  return u ? { id: u.id, login: u.login, displayName: u.display_name } : null;
}

export { devAuthEnabled };
