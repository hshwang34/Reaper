// The preset catalog. Prompt strings live server-side and travel by id only —
// viewers never author these directly (Layer-0 guardrail). Custom free-text is
// a separate, streamer-gated path handled by moderation.

export interface Preset {
  id: string;
  label: string;
  /** Sent to Decart as initialState.prompt.text. */
  prompt: string;
  /** Category for streamer intensity filtering. */
  category: "environment" | "character" | "horror" | "chaotic";
  /** 1 (mild) … 5 (wild). */
  intensity: number;
  /** Emoji used as a lightweight thumbnail in the portal UI. */
  emoji: string;
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
];

export const PRESETS_BY_ID: Record<string, Preset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p]),
);

export function getPreset(id: string | null | undefined): Preset | undefined {
  return id ? PRESETS_BY_ID[id] : undefined;
}
