// Thin fetch helpers over the sidecar HTTP API (same-origin via Vite proxy).

import type { Preset, Settings } from "@rh/shared";

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
  getConfig: () => fetch("/api/config").then(json<PublicConfig>),
  getRouterConfig: () => fetch("/api/router-config").then(json<RouterConfig>),
  getSettings: () => fetch("/api/settings").then(json<Settings>),

  saveSettings: (patch: Partial<Settings>) =>
    fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Settings>),

  submit: (form: FormData) =>
    fetch("/api/submissions", { method: "POST", body: form }).then(
      json<{ code: string; expiresAt: number }>,
    ),

  fakeTip: (amount: number, message: string, username?: string) =>
    fetch("/api/dev/fake-tip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, message, username }),
    }).then(json<{ ok: boolean; outcome: string }>),

  mintToken: (durationSec: number) =>
    fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ durationSec, origin: location.origin }),
    }).then(json<{ token: string }>),

  obsToggle: (visible: boolean) =>
    fetch("/api/obs/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visible }),
    }).then(json<{ ok: boolean; visible?: boolean; error?: string }>),

  panic: () =>
    fetch("/api/panic", { method: "POST" }).then(
      json<{ paused: boolean }>,
    ),
};
