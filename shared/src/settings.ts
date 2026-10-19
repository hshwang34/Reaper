// Streamer-tunable settings: defaults, the money formula, and patch
// validation. This is the ONE place the "$1 = 1s" math lives — the engine
// (server-side, authoritative) and the portal (client-side, preview) both
// call `computeDurationSec` so the price a viewer sees is the duration they
// get.

import {
  PRESET_CATEGORIES,
  type CustomPromptTier,
  type OutputGuardMode,
  type PresetCategory,
  type ReferenceImageTier,
  type Settings,
} from "./types.js";

/** Default settings; every host merges its persisted copy over these. These
 *  are the LOCAL defaults (streamer's own machine, own Decart key — the
 *  streamer is the "developer" under Decart's terms). The hosted plane
 *  starts from HOSTED_SETTINGS instead. */
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
    "photo-swap",
  ],
  allowSolePendingMatch: true,
  customPrompts: "classified",
  maxIntensity: 5,
  allowedCategories: [...PRESET_CATEGORIES],
  referenceImages: "likeness",
  moderationStrictness: "standard",
  outputGuard: "on",
  enhanceCustomPrompts: false,
  reviewLikeness: false,
  showAttribution: true,
  showAiLabel: true,
  blocklistExtra: [],
  bannedViewers: [],
};

/** Hosted defaults (CONTENT-SAFETY §5): our key, our uploads, our liability —
 *  so a new channel starts presets-only with strict thresholds, scene-only
 *  images, a required output guard, and approval on every likeness swap. The
 *  streamer can open each tier deliberately from the dashboard. */
export const HOSTED_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  allowSolePendingMatch: false,
  customPrompts: "off",
  referenceImages: "scenes",
  moderationStrictness: "strict",
  outputGuard: "required",
  reviewLikeness: true,
};

/** Merge a persisted (untrusted-shape) settings object over the defaults.
 *  Runs the same validation as a live patch, so a hand-edited or stale
 *  settings file — one still carrying keys that have since moved out of
 *  Settings — can never produce an invalid Settings object. */
export function loadSettings(persisted: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  return { ...base, ...migrateLegacy(persisted), ...sanitizeSettingsPatch(persisted) };
}

/** Settings files written before the content-policy model carried a plain
 *  `allowCustomPrompts` boolean. Map it once on load; the next save drops it.
 *  `false` stays off; `true` becomes the classified tier — never the
 *  unclassified behavior it used to mean, which no longer exists. */
function migrateLegacy(persisted: unknown): Partial<Settings> {
  if (!persisted || typeof persisted !== "object") return {};
  const p = persisted as Record<string, unknown>;
  if (typeof p.allowCustomPrompts === "boolean" && p.customPrompts === undefined) {
    return { customPrompts: p.allowCustomPrompts ? "classified" : "off" };
  }
  return {};
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
  | "minTipUSD"
  | "maxDurationSec"
  | "secondsPerUSD"
  | "queueDepth"
  | "cooldownSec"
  | "maxIntensity",
  [min: number, max: number]
> = {
  minTipUSD: [0, 10_000],
  maxDurationSec: [1, 600],
  secondsPerUSD: [0.01, 60],
  queueDepth: [0, 100],
  cooldownSec: [0, 120],
  maxIntensity: [1, 5],
};

const BOOLEAN_KEYS = [
  "allowSolePendingMatch",
  "enhanceCustomPrompts",
  "reviewLikeness",
  "showAttribution",
  "showAiLabel",
] as const;

/** Enum-valued knobs: an unknown value is dropped, never coerced. */
const ENUMS: {
  customPrompts: readonly CustomPromptTier[];
  referenceImages: readonly ReferenceImageTier[];
  moderationStrictness: readonly Settings["moderationStrictness"][];
  outputGuard: readonly OutputGuardMode[];
} = {
  customPrompts: ["off", "classified", "classified+approval"],
  referenceImages: ["off", "scenes", "likeness"],
  moderationStrictness: ["strict", "standard"],
  outputGuard: ["off", "on", "required"],
};

function stringList(v: unknown, maxLen = 64): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, 200);
}

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
  if (out.maxIntensity !== undefined) out.maxIntensity = Math.round(out.maxIntensity);
  for (const key of BOOLEAN_KEYS) {
    if (typeof p[key] === "boolean") out[key] = p[key] as boolean;
  }
  for (const key of Object.keys(ENUMS) as (keyof typeof ENUMS)[]) {
    const v = p[key];
    if (typeof v === "string" && (ENUMS[key] as readonly string[]).includes(v)) {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  {
    const v = p.defaultPresetId;
    if (typeof v === "string" && v.trim()) out.defaultPresetId = v.trim().slice(0, 64);
  }
  for (const key of ["enabledPresetIds", "blocklistExtra", "bannedViewers"] as const) {
    const v = stringList(p[key]);
    if (v) out[key] = v;
  }
  {
    const v = stringList(p.allowedCategories);
    if (v) {
      out.allowedCategories = v.filter((c): c is PresetCategory =>
        (PRESET_CATEGORIES as string[]).includes(c),
      );
    }
  }
  return out;
}
