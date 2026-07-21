export * from "./types.js";
export * from "./protocol.js";
export * from "./presets.js";

/** Default guardrail settings; the sidecar loads/overrides from settings.json. */
import type { Settings } from "./types.js";
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
  blocklistExtra: [],
  obsScene: "Scene",
  obsSource: "AI Hijack",
};
