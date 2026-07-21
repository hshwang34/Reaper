// Thin fetch helpers over the sidecar HTTP API (same-origin via Vite proxy).
// Privileged endpoints carry the local auth token when the host requires one
// (Electron/OBS); on the CLI demo rig the header is absent and unchecked.

import type { Preset, Settings } from "@rh/shared";
import { authHeaders } from "./auth.js";
import { apiPath } from "./channel.js";

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

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  getConfig: () => fetch(apiPath("/api/config")).then(json<PublicConfig>),
  getRouterConfig: () =>
    fetch(apiPath("/api/router-config"), { headers: authHeaders() }).then(
      json<RouterConfig>,
    ),
  getSettings: () =>
    fetch(apiPath("/api/settings"), { headers: authHeaders() }).then(json<Settings>),

  saveSettings: (patch: Partial<Settings>) =>
    fetch(apiPath("/api/settings"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    }).then(json<Settings>),

  submit: (form: FormData) =>
    fetch(apiPath("/api/submissions"), { method: "POST", body: form }).then(
      json<{ code: string; expiresAt: number }>,
    ),

  manualHijack: (prompt: string, durationSec: number) =>
    fetch(apiPath("/api/dev/hijack"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ prompt, durationSec }),
    }).then(json<{ ok: boolean; outcome: string }>),

  fakeTip: (amount: number, message: string, username?: string) =>
    fetch(apiPath("/api/dev/fake-tip"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ amount, message, username }),
    }).then(json<{ ok: boolean; outcome: string }>),

  mintToken: (durationSec: number) =>
    fetch(apiPath("/api/token"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ durationSec, origin: location.origin }),
    }).then(json<{ token: string }>),

  obsToggle: (visible: boolean) =>
    fetch(apiPath("/api/obs/toggle"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ visible }),
    }).then(json<{ ok: boolean; visible?: boolean; error?: string }>),

  panic: () =>
    fetch(apiPath("/api/panic"), { method: "POST", headers: authHeaders() }).then(
      json<{ paused: boolean }>,
    ),
};
