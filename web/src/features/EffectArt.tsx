// Effect thumbnails, shared by the studio gallery and the viewer portal.
//
// Every effect gets a small CSS illustration (palette gradient + texture motif
// + emoji) so the card is never empty. When a real recorded preview exists it
// is layered on top: `/previews/<id>.jpg` (the AFTER frame) as the still and
// `/previews/<id>.webm` (<= 6 s loop) played on hover / focus / tap.
//
// The files are found by convention, not a registry, via ONE fetch of
// `/previews/manifest.json` ({ "ids": [...] }, written by
// site/tools/encode-clips.sh --app). We do not probe per-id URLs: the hosted
// and Electron servers answer a missing file with index.html and a 200, so a
// probe can't tell "absent" from "present". No manifest (or not JSON) means an
// empty set, and the component renders exactly the CSS art as before.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Preset } from "@rh/shared";

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

// ── Preview manifest + one-at-a-time playback ────────────────────────────

let manifestIds: ReadonlySet<string> = new Set();
let manifestPromise: Promise<void> | null = null;
const manifestSubs = new Set<() => void>();

/** Fetch the manifest once per page load. Any failure = empty set. */
function loadManifest(): void {
  if (manifestPromise || typeof fetch === "undefined") return;
  manifestPromise = fetch("/previews/manifest.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { ids?: unknown } | null) => {
      if (Array.isArray(j?.ids)) manifestIds = new Set(j.ids.filter((x): x is string => typeof x === "string"));
    })
    .catch(() => {})
    .then(() => manifestSubs.forEach((f) => f()));
}

export function useHasPreview(id: string): boolean {
  useEffect(loadManifest, []);
  return useSyncExternalStore(
    (f) => (manifestSubs.add(f), () => void manifestSubs.delete(f)),
    () => manifestIds.has(id),
    () => false,
  );
}

let playingId: string | null = null;
const playSubs = new Set<() => void>();
/** Start `id`'s loop (stopping any other), or stop playback with null. */
function setPlaying(id: string | null) {
  if (playingId === id) return;
  playingId = id;
  playSubs.forEach((f) => f());
}
function usePlaying(id: string): boolean {
  return useSyncExternalStore(
    (f) => (playSubs.add(f), () => void playSubs.delete(f)),
    () => playingId === id,
    () => false,
  );
}

const media = (q: string) => typeof matchMedia !== "undefined" && matchMedia(q).matches;
/** Hover/focus may start a loop only on a hover-capable device that hasn't asked for less motion. */
const canHoverPlay = () => media("(hover: hover)") && !media("(prefers-reduced-motion: reduce)");

/**
 * Hover/focus handlers for whatever wraps a card: start this effect's loop on
 * enter/focus, stop it on leave/blur. A no-op when there is no preview, on
 * touch, or under reduced motion (those get the play button instead).
 */
export function previewHandlers(id: string) {
  const on = () => {
    if (manifestIds.has(id) && canHoverPlay()) setPlaying(id);
  };
  const off = () => {
    if (playingId === id) setPlaying(null);
  };
  return { onPointerEnter: on, onPointerLeave: off, onFocus: on, onBlur: off };
}

/**
 * The 44px play control for touch / reduced-motion. It must be rendered as a
 * SIBLING of a card <button>, never inside it (a button in a button is invalid
 * HTML and would pollute the card's accessible name).
 */
export function PreviewPlayButton({
  id,
  label,
  className = "",
  reducedMotionOnly = false,
}: {
  id: string;
  label: string;
  className?: string;
  /** For a loop that already autoplays: offer the button only when reduced motion stopped it. */
  reducedMotionOnly?: boolean;
}) {
  const has = useHasPreview(id);
  const playing = usePlaying(id);
  const [needsButton, setNeedsButton] = useState(false);
  useEffect(
    () => setNeedsButton(reducedMotionOnly ? media("(prefers-reduced-motion: reduce)") : !canHoverPlay()),
    [reducedMotionOnly],
  );
  if (!has || !needsButton) return null;
  return (
    <button
      type="button"
      aria-label={playing ? `Stop preview of ${label}` : `Play preview of ${label}`}
      aria-pressed={playing}
      onClick={() => setPlaying(playing ? null : id)}
      className={`pointer-events-auto absolute bottom-1 right-1 z-10 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white backdrop-blur hover:bg-black/80 ${className}`}
    >
      <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
    </button>
  );
}

/** 16:9 thumbnail for an effect. Decorative — the card's label names it. */
export function EffectArt({
  preset,
  className = "",
  size = "md",
  autoPlay = false,
}: {
  preset: Pick<Preset, "id" | "category" | "editType" | "emoji">;
  className?: string;
  size?: "sm" | "md" | "lg";
  /** Loop as soon as it is on screen (the large Customize panel); still
   *  honours reduced motion. Cards instead play on hover/focus/tap. */
  autoPlay?: boolean;
}) {
  const emoji = size === "lg" ? "text-6xl" : size === "sm" ? "text-2xl" : "text-4xl";
  const has = useHasPreview(preset.id);
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [stillFailed, setStillFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [everPlayed, setEverPlayed] = useState(false);
  const storePlaying = usePlaying(preset.id);
  // One loop at a time: an autoplaying hero yields while a card is hovered/tapped.
  const otherPlaying = useSyncExternalStore(
    (f) => (playSubs.add(f), () => void playSubs.delete(f)),
    () => playingId !== null && playingId !== preset.id,
    () => false,
  );
  const playing = (autoPlay && visible && !otherPlaying && !media("(prefers-reduced-motion: reduce)")) || storePlaying;

  // Lazy: nothing is requested until the card scrolls near the viewport.
  useEffect(() => {
    if (!has || visible) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [has, visible]);

  useEffect(() => {
    if (playing) setEverPlayed(true);
  }, [playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => {});
    else {
      v.pause();
      v.currentTime = 0;
      setVideoReady(false);
    }
  }, [playing, everPlayed]);

  const showStill = has && visible && !stillFailed;
  const showVideo = has && !videoFailed && everPlayed;
  return (
    <div
      ref={rootRef}
      aria-hidden
      className={`relative aspect-video overflow-hidden ${className}`}
      style={{ background: `${MOTIF[preset.editType]}, ${effectGradient(preset)}` }}
    >
      <span className={`absolute inset-0 grid place-items-center drop-shadow-[0_4px_12px_rgba(0,0,0,.45)] ${emoji}`}>
        {preset.emoji}
      </span>
      {showStill && (
        <img
          src={`/previews/${preset.id}.jpg`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setStillFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {showVideo && (
        <video
          ref={videoRef}
          src={`/previews/${preset.id}.webm`}
          muted
          loop
          playsInline
          preload="none"
          onPlaying={() => setVideoReady(true)}
          onError={() => setVideoFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${videoReady ? "opacity-100" : "opacity-0"}`}
        />
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
