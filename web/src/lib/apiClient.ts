// ONE typed HTTP client for the channel API, with a pluggable credential.
//
// The same routes are served by three hosts (demo rig, Electron bridge, hosted
// control plane) and reached from three kinds of page, which used to mean
// three auth idioms: the install token header on local pages, a hand-rolled
// Bearer fetch in the dashboard with no 401 handling, and channel-prefixing
// bolted on separately. The client owns all of it:
//   · path scoping   — `/api/...` locally, `/api/c/<channel>/...` hosted
//   · credential     — install token (x-rh-auth) or session JWT (Bearer)
//   · session upkeep — on a 401 with a session credential, rotate the refresh
//                      token ONCE (they are single-use), persist it through
//                      onRotate, and retry; a second 401 surfaces as ApiError
// Pages call typed methods and never see a header.

import type { Settings, Preset } from "@rh/shared";

// ── Response shapes ───────────────────────────────────────────────────────

export interface PublicConfig {
  presets: Preset[];
  allowCustomPrompts: boolean;
  minTipUSD: number;
  maxDurationSec: number;
  secondsPerUSD: number;
  decartEnabled: boolean;
}

export interface RouterConfig {
  decartEnabled: boolean;
  obsScene: string;
  obsSource: string;
  obsConnected: boolean;
}

export interface LedgerRow {
  jobId: string;
  source: string;
  username: string;
  amountUsd: number;
  durationSec: number;
  prompt: string;
  outcome: string;
  reason: string | null;
  createdAt: number;
}

/** What the hosted plane hands back on sign-in / refresh / exchange. */
export interface SessionTokens {
  access: string;
  refresh: string;
  channelId: string;
  login: string;
}

// ── Credentials ───────────────────────────────────────────────────────────

export type Credential =
  /** Public viewer pages: no privileged calls. */
  | { kind: "none" }
  /** Local pages (router/viewer): the per-install token. Resolved lazily so
   *  a token that arrives via ?auth= after module load is still picked up. */
  | { kind: "install"; token: () => string | undefined }
  /** Hosted dashboard: our JWT session. `onRotate` is how the caller
   *  persists the new refresh token after a rotation. */
  | {
      kind: "session";
      tokens: SessionTokens;
      onRotate: (next: SessionTokens) => void;
    };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Hosted channel (login or id); omit/null for the local rig. A function
   *  is resolved per request, so a client can be built at module load (the
   *  page-level singleton) without touching `location` — which also keeps
   *  modules that import it loadable under node:test. */
  channel?: string | null | (() => string | null);
  credential: Credential;
}

// ── Session helpers (hosted dashboard) ────────────────────────────────────

/** POST to an /auth endpoint; null on refusal. */
async function postAuth(path: string, body: object): Promise<SessionTokens | null> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()) as SessionTokens;
}

/** Redeem the single-use sign-in exchange code (see server/src/auth.ts). */
export const redeemExchangeCode = (code: string) => postAuth("/auth/exchange", { code });

/** Rotate a refresh token into a fresh pair. Refresh tokens are single-use:
 *  whatever the outcome, the presented token is dead afterwards. */
export const rotateRefresh = (refresh: string) => postAuth("/auth/refresh", { refresh });

// ── The client ────────────────────────────────────────────────────────────

export function createApiClient(opts: ApiClientOptions) {
  const cred = opts.credential;
  const prefix = () => {
    const ch = typeof opts.channel === "function" ? opts.channel() : opts.channel;
    return ch ? `/api/c/${encodeURIComponent(ch)}` : "/api";
  };

  function authHeaders(): Record<string, string> {
    if (cred.kind === "install") {
      const t = cred.token();
      return t ? { "x-rh-auth": t } : {};
    }
    if (cred.kind === "session") return { authorization: `Bearer ${cred.tokens.access}` };
    return {};
  }

  async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const res = await fetch(prefix() + path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
    });
    if (res.status === 401 && cred.kind === "session" && !retried) {
      // The 15-minute access token lapsed mid-session. Rotate once, then
      // retry the same call; a second 401 means the refresh is dead too.
      const next = await rotateRefresh(cred.tokens.refresh);
      if (next) {
        cred.tokens = next;
        cred.onRotate(next);
        return request<T>(path, init, true);
      }
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
    return body as T;
  }

  const json = (method: "POST", payload: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  return {
    // public
    getConfig: () => request<PublicConfig>("/config"),
    submit: (form: FormData) =>
      request<{ code: string; expiresAt: number }>("/submissions", { method: "POST", body: form }),

    // streamer-privileged (install token locally, session JWT hosted)
    getRouterConfig: () => request<RouterConfig>("/router-config"),
    getSettings: () => request<Settings>("/settings"),
    saveSettings: (patch: Partial<Settings>) => request<Settings>("/settings", json("POST", patch)),
    manualHijack: (prompt: string, durationSec: number) =>
      request<{ ok: boolean; outcome: string }>("/dev/hijack", json("POST", { prompt, durationSec })),
    fakeTip: (amount: number, message: string, username?: string) =>
      request<{ ok: boolean; outcome: string }>(
        "/dev/fake-tip",
        json("POST", { amount, message, username }),
      ),
    mintToken: (durationSec: number) =>
      request<{ token: string }>("/token", json("POST", { durationSec, origin: location.origin })),
    obsToggle: (visible: boolean) =>
      request<{ ok: boolean; visible?: boolean; error?: string }>("/obs/toggle", json("POST", { visible })),
    panic: () => request<{ paused: boolean }>("/panic", { method: "POST" }),

    // hosted-only
    ledger: () => request<LedgerRow[]>("/ledger"),
    connectStreamlabs: (token: string) =>
      request<{ ok: boolean; connected: boolean }>("/trigger/streamlabs", json("POST", { token })),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
