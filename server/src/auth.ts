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

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
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

/** Constant-time string equality. A plain `!==` short-circuits on the first
 *  differing byte, which leaks how much of a presented secret matched — not
 *  practically exploitable over a network at hash length, but free to fix. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── One-time exchange codes (browser sign-in) ─────────────────────────────
// The OAuth callback must hand the session to the dashboard SPA somehow. A
// URL fragment never reaches a server, but it does land in browser history,
// referrer-stripped-but-still-visible page JS, and any extension — so a
// 30-day refresh token must not ride it. Instead the callback mints a random
// code that is single-use and expires in seconds; the SPA redeems it via POST
// once, and what lands in history is worthless a minute later. In-memory is
// fine: a code only ever needs to survive one redirect on one process.

const EXCHANGE_TTL_MS = 60 * 1000;
const exchangeCodes = new Map<string, { tokens: SessionTokens; expiresAt: number }>();

export function issueExchangeCode(tokens: SessionTokens): string {
  // Opportunistic sweep so an abandoned sign-in never accumulates.
  const now = Date.now();
  for (const [k, v] of exchangeCodes) if (v.expiresAt <= now) exchangeCodes.delete(k);
  const code = randomBytes(24).toString("base64url");
  exchangeCodes.set(code, { tokens, expiresAt: now + EXCHANGE_TTL_MS });
  return code;
}

/** Redeem a code exactly once; null if unknown, expired, or already used. */
export function redeemExchangeCode(code: string): SessionTokens | null {
  const entry = exchangeCodes.get(code);
  if (!entry) return null;
  exchangeCodes.delete(code); // burn on first touch, valid or not
  if (entry.expiresAt <= Date.now()) return null;
  return entry.tokens;
}

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
  if (!row || !safeEqual(row.tokenHash, sha256(refresh)) || row.expiresAt < Date.now()) {
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

/** Resolve :channel as id or login (vanity portal URLs use logins). The id
 *  wins on a collision. This is the ONE resolver: the auth gate and the
 *  channel API must agree on which channel a param means, or a login that
 *  happens to equal another channel's id could pass the gate as its owner
 *  while the handler acts on the other channel. */
export function resolveChannelId(param: string): string | null {
  const byId = db.select().from(channels).where(eq(channels.id, param)).get();
  if (byId) return byId.id;
  const byLogin = db
    .select()
    .from(channels)
    .where(eq(channels.login, param.toLowerCase()))
    .get();
  return byLogin?.id ?? null;
}

/** Express guard: Bearer token must belong to the channel :channel names. */
export const requireChannel: RequestHandler = async (req, res, next) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const sub = token ? await verifyAccess(token) : null;
  if (!sub) {
    res.status(401).json({ error: "auth required" });
    return;
  }
  // :channel may be the id or the vanity login (the portal URL form). A valid
  // token for a DIFFERENT channel is 403, not 401 — re-authenticating won't help.
  if (resolveChannelId(String(req.params.channel)) !== sub) {
    res.status(403).json({ error: "not your channel" });
    return;
  }
  // Downstream handlers key on the id, never the login.
  res.locals.channelId = sub;
  next();
};

export function upsertChannel(
  id: string,
  login: string,
  displayName: string,
): void {
  login = login.toLowerCase();
  db.transaction((tx) => {
    // Twitch logins are renameable and get recycled. The row keyed by `id`
    // (the immutable Twitch user id) is the truth, so a stale row still
    // holding this login belongs to someone who renamed away from it — free
    // the UNIQUE login for the current holder rather than letting the insert
    // throw and wedge this user's sign-in forever.
    const squatter = tx.select().from(channels).where(eq(channels.login, login)).get();
    if (squatter && squatter.id !== id) {
      tx.update(channels)
        .set({ login: `${login}~${squatter.id}` })
        .where(eq(channels.id, squatter.id))
        .run();
      warn("auth", `login ${login} moved from ${squatter.id} to ${id} (Twitch rename)`);
    }
    const existing = tx.select().from(channels).where(eq(channels.id, id)).get();
    if (existing) {
      // Keep the vanity URL (/c/:login) and display name tracking Twitch.
      if (existing.login !== login || existing.displayName !== displayName) {
        tx.update(channels).set({ login, displayName }).where(eq(channels.id, id)).run();
      }
      return;
    }
    tx.insert(channels)
      .values({
        id,
        login,
        displayName,
        // Nothing persisted until the streamer changes something: the
        // channel then reads as HOSTED_SETTINGS (channels.ts), and a later
        // change to those defaults reaches it. Persisting DEFAULT_SETTINGS
        // here used to override the hosted base wholesale — new channels got
        // the local rig's lenient screening + sole-pending tip matching.
        settingsJson: "{}",
        createdAt: Date.now(),
      })
      .run();
    log("auth", `provisioned channel ${login} (${id})`);
  });
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
  /** The desktop app's own sign-in nonce, round-tripped back to its loopback
   *  listener so it can reject callbacks it didn't initiate. */
  appState?: string;
}): Promise<string> {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(secret);
}

export async function readState(
  state: string,
): Promise<{ app?: boolean; nonce?: string; appState?: string } | null> {
  try {
    const { payload } = await jwtVerify(state, secret);
    return payload as { app?: boolean; nonce?: string; appState?: string };
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
