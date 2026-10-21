// The preset catalog. Prompt strings live server-side and travel by id only —
// viewers never author these directly (Layer-0 guardrail). Custom free-text is
// a separate, streamer-gated path handled by moderation.

import type { PresetCategory, Settings } from "./types.js";

/** Decart's Lucy 2.5 prompt guide sorts every edit into one of these kinds;
 *  the studio's "what's possible" gallery groups by them. */
export type EditType =
  | "restyle"
  | "background"
  | "character"
  | "add"
  | "attribute"
  | "vfx";

export const EDIT_TYPE_LABEL: Record<EditType, string> = {
  restyle: "Restyle the whole scene",
  background: "New background",
  character: "Become someone else",
  add: "Add something",
  attribute: "Change an outfit",
  vfx: "Visual effects",
};

export interface Preset {
  id: string;
  label: string;
  /** One line for gallery cards — what the audience will see. */
  pitch: string;
  editType: EditType;
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
    pitch: "The floor is lava. Literally.",
    editType: "vfx",
    prompt:
      "The entire room is flooded with molten lava, glowing orange cracks across the floor and walls, embers floating in the air, intense volcanic lighting",
    category: "environment",
    intensity: 4,
    emoji: "🌋",
  },
  {
    id: "underwater",
    label: "Underwater",
    pitch: "Sunk to the bottom of the sea",
    editType: "restyle",
    prompt:
      "The room is submerged deep underwater, shafts of blue light from above, drifting bubbles, floating particles, gentle caustic reflections on every surface",
    category: "environment",
    intensity: 2,
    emoji: "🌊",
  },
  {
    id: "80s-anime",
    label: "80s Anime",
    pitch: "Straight out of a VHS-era cartoon",
    editType: "restyle",
    prompt:
      "Retro 1980s anime cel-shaded style, bold ink outlines, neon sunset gradients, film grain, nostalgic VHS color palette",
    category: "character",
    intensity: 3,
    emoji: "📼",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk City",
    pitch: "Neon rain, holograms, Night City",
    editType: "background",
    prompt:
      "Neon cyberpunk cityscape backdrop, holographic signs, rain-slicked reflections, teal and magenta lighting, dense futuristic atmosphere",
    category: "environment",
    intensity: 3,
    emoji: "🌃",
  },
  {
    id: "haunted",
    label: "Haunted",
    pitch: "Candlelight, mist, and something behind you",
    editType: "restyle",
    prompt:
      "Eerie haunted scene, desaturated cold tones, creeping shadows, faint ghostly mist, flickering candlelight, unsettling gothic atmosphere",
    category: "horror",
    intensity: 4,
    emoji: "👻",
  },
  {
    id: "winter-wonderland",
    label: "Winter Wonderland",
    pitch: "Snowfall and fairy lights",
    editType: "background",
    prompt:
      "A magical snowy winter wonderland, soft falling snow, frost on every surface, warm golden fairy lights, cozy pastel palette",
    category: "environment",
    intensity: 1,
    emoji: "❄️",
  },
  // ── Catalog v2 (2026-10): written to Decart's Lucy 2.5 prompt guide —
  // one focused edit per prompt, concrete nouns, placement stated, no
  // negative instructions. Ids are permanent (saved settings reference them).
  {
    id: "beach-sunset",
    label: "Beach Sunset",
    pitch: "Palm trees and golden-hour surf behind you",
    editType: "background",
    prompt:
      "Change the background to a tropical beach at sunset, palm trees swaying, gentle waves rolling onto golden sand, warm orange sky. Keep the person unchanged.",
    category: "environment",
    intensity: 1,
    emoji: "🏝️",
  },
  {
    id: "watercolor",
    label: "Watercolor",
    pitch: "The whole stream becomes a moving painting",
    editType: "restyle",
    prompt:
      "Transform the entire scene into a soft watercolor painting: loose wet brush strokes, pigment blooms at the edges, pale paper texture showing through, gentle pastel palette.",
    category: "character",
    intensity: 2,
    emoji: "🎨",
  },
  {
    id: "woodblock",
    label: "Woodblock Print",
    pitch: "Japanese ukiyo-e, ink and paper",
    editType: "restyle",
    prompt:
      "Transform the entire scene into a Japanese ukiyo-e woodblock print: flat areas of indigo, vermilion and cream, bold black carved outlines, visible wood-grain paper texture.",
    category: "character",
    intensity: 2,
    emoji: "🗾",
  },
  {
    id: "yarn-world",
    label: "Yarn World",
    pitch: "Everything is crocheted. Everything.",
    editType: "restyle",
    prompt:
      "Transform the entire scene into a handmade crocheted yarn world: every surface, object and person knitted from chunky colorful wool, visible stitches and soft fuzzy fibers.",
    category: "chaotic",
    intensity: 2,
    emoji: "🧶",
  },
  {
    id: "space-explorer",
    label: "Space Explorer",
    pitch: "Suited up in silver armor among the stars",
    editType: "character",
    prompt:
      "Replace the character in the video with a space explorer in polished silver armor and a sleek helmet with a reflective visor. Keep the same pose and movements.",
    category: "character",
    intensity: 3,
    emoji: "🧑‍🚀",
  },
  {
    id: "knight",
    label: "Medieval Knight",
    pitch: "Full plate armor, ready for a joust",
    editType: "attribute",
    prompt:
      "Change the person's outfit to a full suit of medieval steel plate armor with a red tabard over the chest. Keep the face and hair unchanged.",
    category: "character",
    intensity: 2,
    emoji: "🛡️",
  },
  {
    id: "cartoon-chef",
    label: "Cartoon Chef",
    pitch: "A cheerful animated chef takes over",
    editType: "character",
    prompt:
      "Replace the character in the video with a cheerful 3D cartoon chef wearing a tall white toque and a white double-breasted jacket. Keep the same pose and movements.",
    category: "character",
    intensity: 3,
    emoji: "👨‍🍳",
  },
  {
    id: "parrot-party",
    label: "Parrot Party",
    pitch: "Two macaws land on your shoulders",
    editType: "add",
    prompt:
      "Add two bright red and blue macaw parrots perched on the person's shoulders, fluttering their wings and turning their heads.",
    category: "chaotic",
    intensity: 2,
    emoji: "🦜",
  },
  {
    id: "superhero-cape",
    label: "Superhero Cape",
    pitch: "A billowing cape, hero lighting",
    editType: "add",
    prompt:
      "Add a long flowing royal blue cape fastened at the person's shoulders, billowing gently behind them as they move.",
    category: "character",
    intensity: 1,
    emoji: "🦸",
  },
  {
    id: "on-fire",
    label: "Room on Fire",
    pitch: "Flames lick up the walls (you're fine)",
    editType: "vfx",
    prompt:
      "Add roaring flames climbing the walls behind the person, flickering orange firelight on every surface, drifting sparks and smoke near the ceiling. Keep the person unharmed and unchanged.",
    category: "chaotic",
    intensity: 4,
    emoji: "🔥",
  },
  {
    // lucy-2.5's headline capability: swap the person on camera for whoever is
    // in the reference image. Decart's own docs run this prompt with enhance
    // on; the viewer's toggle still applies.
    id: "photo-swap",
    label: "Become the Photo",
    pitch: "Turn the streamer into anyone in a photo",
    editType: "character",
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

/** Presets a streamer's content policy permits: not switched off, under the intensity
 *  ceiling, in an allowed category, and — for likeness swaps — only when the
 *  policy allows face images at all. The portal renders this list and intake
 *  enforces it, so the two can't disagree. */
export function presetAllowed(
  p: Preset,
  s: Pick<
    Settings,
    "disabledPresetIds" | "maxIntensity" | "allowedCategories" | "referenceImages"
  >,
): boolean {
  if (s.disabledPresetIds.includes(p.id)) return false;
  if (p.intensity > s.maxIntensity) return false;
  if (!s.allowedCategories.includes(p.category)) return false;
  if (p.needsImage && s.referenceImages !== "likeness") return false;
  return true;
}
