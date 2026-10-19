// The preset catalog. Prompt strings live server-side and travel by id only —
// viewers never author these directly (Layer-0 guardrail). Custom free-text is
// a separate, streamer-gated path handled by moderation.

import type { PresetCategory, Settings } from "./types.js";

export interface Preset {
  id: string;
  label: string;
  /** Sent to Decart as initialState.prompt.text. */
  prompt: string;
  /** Category for streamer intensity filtering. */
  category: PresetCategory;
  /** 1 (mild) … 5 (wild). */
  intensity: number;
  /** Emoji used as a lightweight thumbnail in the portal UI. */
  emoji: string;
  /** The prompt only makes sense with a reference image (lucy-2.5 character
   *  substitution). Portal gates the pick on an attached photo; the server
   *  rejects the submission without one instead of running a no-op. */
  needsImage?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "lava-room",
    label: "Lava Room",
    prompt:
      "The entire room is flooded with molten lava, glowing orange cracks across the floor and walls, embers floating in the air, intense volcanic lighting",
    category: "environment",
    intensity: 4,
    emoji: "🌋",
  },
  {
    id: "underwater",
    label: "Underwater",
    prompt:
      "The room is submerged deep underwater, shafts of blue light from above, drifting bubbles, floating particles, gentle caustic reflections on every surface",
    category: "environment",
    intensity: 2,
    emoji: "🌊",
  },
  {
    id: "80s-anime",
    label: "80s Anime",
    prompt:
      "Retro 1980s anime cel-shaded style, bold ink outlines, neon sunset gradients, film grain, nostalgic VHS color palette",
    category: "character",
    intensity: 3,
    emoji: "📼",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk City",
    prompt:
      "Neon cyberpunk cityscape backdrop, holographic signs, rain-slicked reflections, teal and magenta lighting, dense futuristic atmosphere",
    category: "environment",
    intensity: 3,
    emoji: "🌃",
  },
  {
    id: "haunted",
    label: "Haunted",
    prompt:
      "Eerie haunted scene, desaturated cold tones, creeping shadows, faint ghostly mist, flickering candlelight, unsettling gothic atmosphere",
    category: "horror",
    intensity: 4,
    emoji: "👻",
  },
  {
    id: "winter-wonderland",
    label: "Winter Wonderland",
    prompt:
      "A magical snowy winter wonderland, soft falling snow, frost on every surface, warm golden fairy lights, cozy pastel palette",
    category: "environment",
    intensity: 1,
    emoji: "❄️",
  },
  {
    // lucy-2.5's headline capability: swap the person on camera for whoever is
    // in the reference image. Decart's own docs run this prompt with enhance
    // on; the viewer's toggle still applies.
    id: "photo-swap",
    label: "Become the Photo",
    prompt:
      "Substitute the character in the video with the person in the reference image — match their face, hair and outfit, keep the original pose, framing and lighting",
    category: "character",
    intensity: 3,
    emoji: "🪞",
    needsImage: true,
  },
];

export const PRESETS_BY_ID: Record<string, Preset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p]),
);

export function getPreset(id: string | null | undefined): Preset | undefined {
  // Own-property check: `id` comes off the public submissions endpoint, and a
  // plain-object lookup of "__proto__" / "constructor" returns a truthy
  // prototype member instead of undefined (→ a job with prompt: undefined).
  return id && Object.hasOwn(PRESETS_BY_ID, id) ? PRESETS_BY_ID[id] : undefined;
}

/** Presets a streamer's content policy permits: enabled, under the intensity
 *  ceiling, in an allowed category, and — for likeness swaps — only when the
 *  policy allows face images at all. The portal renders this list and intake
 *  enforces it, so the two can't disagree. */
export function presetAllowed(
  p: Preset,
  s: Pick<
    Settings,
    "enabledPresetIds" | "maxIntensity" | "allowedCategories" | "referenceImages"
  >,
): boolean {
  if (!s.enabledPresetIds.includes(p.id)) return false;
  if (p.intensity > s.maxIntensity) return false;
  if (!s.allowedCategories.includes(p.category)) return false;
  if (p.needsImage && s.referenceImages !== "likeness") return false;
  return true;
}
