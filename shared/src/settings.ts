// Streamer-tunable settings: defaults, the money formula, and patch
// validation. This is the ONE place the "$1 = 1s" math lives — the engine
// (server-side, authoritative) and the portal (client-side, preview) both
// call `computeDurationSec` so the price a viewer sees is the duration they
// get.

import type { Settings } from "./types.js";

/** Default guardrail settings; every host merges its persisted copy over these. */
export const DEFAULT_SETTINGS: Settings = {
  minTipUSD: 2,
  maxDurationSec: 60,
  secondsPerUSD: 1,
  queueDepth: 5,
  cooldownSec: 3,
  defaultPresetId: "80s-anime",
  enabledPresetIds: [
    "lava-room",
    "underwater",
    "80s-anime",
    "cyberpunk",
    "haunted",
    "winter-wonderland",
  ],
  allowCustomPrompts: true,
  allowSolePendingMatch: true,
  blocklistExtra: [],
};

/** Merge a persisted (untrusted-shape) settings object over the defaults.
 *  Runs the same validation as a live patch, so a hand-edited or stale
 *  settings file — one still carrying keys that have since moved out of
 *  Settings — can never produce an invalid Settings object. */
export function loadSettings(persisted: unknown): Settings {
  return { ...DEFAULT_SETTINGS, ...sanitizeSettingsPatch(persisted) };
}

/** Paid seconds for a tip: floor(amount × rate), at least 1, capped. */
export function computeDurationSec(
  amountUsd: number,
  s: Pick<Settings, "secondsPerUSD" | "maxDurationSec">,
): number {
  return Math.min(
    Math.max(1, Math.floor(amountUsd * s.secondsPerUSD)),
    s.maxDurationSec,
  );
}

/** Hard bounds on the numeric knobs. Wide enough for any real streamer,
 *  tight enough that a bad patch can't make a $5 tip run for a year. */
const NUMERIC_BOUNDS: Record<
  "minTipUSD" | "maxDurationSec" | "secondsPerUSD" | "queueDepth" | "cooldownSec",
  [min: number, max: number]
> = {
  minTipUSD: [0, 10_000],
  maxDurationSec: [1, 600],
  secondsPerUSD: [0.01, 60],
  queueDepth: [0, 100],
  cooldownSec: [0, 120],
};

/**
 * Reduce an untrusted settings patch (a JSON body from an authed streamer
 * page) to the fields we know, with the types and bounds we expect. Unknown
 * keys are dropped; malformed values are dropped rather than coerced, so a
 * broken client can never persist a broken settings file.
 */
export function sanitizeSettingsPatch(input: unknown): Partial<Settings> {
  if (!input || typeof input !== "object") return {};
  const p = input as Record<string, unknown>;
  const out: Partial<Settings> = {};

  for (const key of Object.keys(NUMERIC_BOUNDS) as (keyof typeof NUMERIC_BOUNDS)[]) {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const [min, max] = NUMERIC_BOUNDS[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  for (const key of ["allowCustomPrompts", "allowSolePendingMatch"] as const) {
    if (typeof p[key] === "boolean") out[key] = p[key] as boolean;
  }
  {
    const v = p.defaultPresetId;
    if (typeof v === "string" && v.trim()) out.defaultPresetId = v.trim().slice(0, 64);
  }
  for (const key of ["enabledPresetIds", "blocklistExtra"] as const) {
    const v = p[key];
    if (Array.isArray(v)) {
      out[key] = v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 200);
    }
  }
  return out;
}
