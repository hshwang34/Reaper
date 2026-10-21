// Effect thumbnails, shared by the studio gallery and the viewer portal.
//
// We can't show Decart's own sample media (their site terms), and we haven't
// recorded our own clips yet (site/CLIPS.md), so each effect gets a small
// CSS illustration instead: the effect's palette as a gradient, a texture
// motif for its kind of edit, and its emoji as the subject. When a recorded
// clip exists for a preset, drop it in CLIPS below and the card plays it.

import type { Preset } from "@rh/shared";

/** Recorded before/after loops, by preset id — empty until we record them. */
const CLIPS: Record<string, string> = {};

/** Per-effect palette: [from, via, to]. Falls back by category. */
const PALETTE: Record<string, [string, string, string]> = {
  "lava-room": ["#2a0500", "#b3260b", "#ffb347"],
  underwater: ["#021b33", "#0b5d8c", "#5fd3e8"],
  "80s-anime": ["#2b0b3d", "#d9367a", "#ffb86b"],
  cyberpunk: ["#0b0620", "#3b1e8f", "#19e3d6"],
  haunted: ["#07090c", "#2a3540", "#8fa3a8"],
  "winter-wonderland": ["#0d1b2e", "#5c84b8", "#f4e3b5"],
  "photo-swap": ["#1a1020", "#6b4a8f", "#f0c8ff"],
  "beach-sunset": ["#1f0b2e", "#e0584a", "#ffd27a"],
  watercolor: ["#2c2433", "#8fb8d8", "#f6d6e0"],
  woodblock: ["#1d2430", "#2f4d7a", "#e8dcc0"],
  "yarn-world": ["#3a1430", "#e2637a", "#ffd166"],
  "space-explorer": ["#05060f", "#2b3a67", "#c9d6e8"],
  knight: ["#121418", "#5b6470", "#c8ced6"],
  "cartoon-chef": ["#2b1406", "#e08a2e", "#fff3d6"],
  "parrot-party": ["#06240f", "#1f8f4a", "#ff4f3a"],
  "superhero-cape": ["#070f2e", "#1f4fd1", "#ffcf3a"],
  "on-fire": ["#160300", "#e0400f", "#ffd23a"],
};
const BY_CATEGORY: Record<Preset["category"], [string, string, string]> = {
  environment: ["#0b1d2a", "#2f6f8f", "#a5e0d0"],
  character: ["#1d1030", "#7a3fa0", "#f0b8ff"],
  horror: ["#08090b", "#33303a", "#9a8f9f"],
  chaotic: ["#2a0a10", "#d9365a", "#ffc65c"],
};

/** Texture overlay per kind of edit — the visual hint of what changes. */
const MOTIF: Record<Preset["editType"], string> = {
  restyle:
    "repeating-linear-gradient(115deg, rgba(255,255,255,.07) 0 2px, transparent 2px 9px)",
  background:
    "radial-gradient(ellipse at 50% 120%, rgba(0,0,0,.55) 0 38%, transparent 39%)",
  character:
    "radial-gradient(circle at 50% 42%, rgba(255,255,255,.18) 0 22%, transparent 23%)",
  add: "radial-gradient(circle at 22% 30%, rgba(255,255,255,.22) 0 6%, transparent 7%), radial-gradient(circle at 78% 30%, rgba(255,255,255,.22) 0 6%, transparent 7%)",
  attribute:
    "linear-gradient(180deg, transparent 55%, rgba(255,255,255,.12) 55% 100%)",
  vfx: "radial-gradient(circle at 20% 80%, rgba(255,240,200,.35) 0 3%, transparent 4%), radial-gradient(circle at 70% 65%, rgba(255,240,200,.3) 0 2%, transparent 3%), radial-gradient(circle at 45% 90%, rgba(255,240,200,.3) 0 2.5%, transparent 3.5%)",
};

export function effectGradient(p: Pick<Preset, "id" | "category">): string {
  const [a, b, c] = PALETTE[p.id] ?? BY_CATEGORY[p.category];
  return `linear-gradient(135deg, ${a} 0%, ${b} 55%, ${c} 100%)`;
}

/** 16:9 thumbnail for an effect. Decorative — the card's label names it. */
export function EffectArt({
  preset,
  className = "",
  size = "md",
}: {
  preset: Pick<Preset, "id" | "category" | "editType" | "emoji">;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const clip = CLIPS[preset.id];
  const emoji = size === "lg" ? "text-6xl" : size === "sm" ? "text-2xl" : "text-4xl";
  return (
    <div
      aria-hidden
      className={`relative aspect-video overflow-hidden ${className}`}
      style={{ background: `${MOTIF[preset.editType]}, ${effectGradient(preset)}` }}
    >
      {clip ? (
        <video src={clip} muted loop autoPlay playsInline className="h-full w-full object-cover" />
      ) : (
        <span className={`absolute inset-0 grid place-items-center drop-shadow-[0_4px_12px_rgba(0,0,0,.45)] ${emoji}`}>
          {preset.emoji}
        </span>
      )}
    </div>
  );
}

/** The streamer-facing name for a preset category. */
export const CATEGORY_LABEL: Record<Preset["category"], string> = {
  environment: "Scenes",
  character: "Characters & styles",
  horror: "Spooky",
  chaotic: "Chaotic",
};

/** 1–5 intensity as flames — never color alone. */
export function Intensity({ level }: { level: number }) {
  return (
    <span className="shrink-0 whitespace-nowrap text-xs tracking-tight" title={`Intensity ${level} of 5`}>
      <span aria-hidden>{"🔥".repeat(level)}</span>
      <span className="sr-only">Intensity {level} of 5</span>
    </span>
  );
}
