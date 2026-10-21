// Step 1 of the portal: pick an effect. Filter chips over a grid of effect
// cards (EffectArt thumbnails), plus a "Your own idea" tile when the channel
// takes custom prompts. Cards are real toggle buttons (aria-pressed) so the
// grid is keyboard- and screen-reader-navigable; selection is shown by a ring
// AND a check badge, never by color alone.

import { useMemo, useState } from "react";
import type { Preset } from "@rh/shared";
import { CATEGORY_LABEL, EffectArt, Intensity, PreviewPlayButton, previewHandlers } from "../features/EffectArt.js";

type Filter = "all" | Preset["category"] | "photo";

const FILTER_ORDER: Filter[] = ["all", "environment", "character", "horror", "chaotic", "photo"];
const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  ...CATEGORY_LABEL,
  photo: "Needs a photo",
};

export function EffectPicker({
  presets,
  selectedId,
  writing,
  allowCustom,
  hasPhoto,
  emptyText,
  onPick,
  onWrite,
}: {
  presets: Preset[];
  selectedId: string | null;
  /** "Your own idea" is the current choice. */
  writing: boolean;
  allowCustom: boolean;
  /** A photo is attached — photo-only cards say so. */
  hasPhoto: boolean;
  /** Shown when this channel has no effects at all. */
  emptyText: string;
  onPick: (id: string) => void;
  onWrite: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  // Only offer filters that would show something on this channel.
  const filters = useMemo(
    () =>
      FILTER_ORDER.filter((f) =>
        f === "all" ? true : presets.some((p) => (f === "photo" ? p.needsImage : p.category === f)),
      ),
    [presets],
  );
  const shown = presets.filter((p) =>
    filter === "all" ? true : filter === "photo" ? p.needsImage : p.category === filter,
  );

  return (
    <div>
      {filters.length > 2 && (
        <div
          role="group"
          aria-label="Filter effects"
          className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`h-11 shrink-0 rounded-full border px-4 text-sm font-medium whitespace-nowrap ${
                filter === f
                  ? "border-brand-400 bg-brand-400/10 text-brand-200"
                  : "border-zinc-700/80 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
              }`}
            >
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3">
        {allowCustom && (filter === "all") && (
          <button
            type="button"
            aria-pressed={writing}
            onClick={onWrite}
            className={`group relative flex flex-col overflow-hidden rounded-2xl border text-left ${
              writing
                ? "border-brand-400 ring-2 ring-brand-400"
                : "border-dashed border-zinc-600 hover:border-zinc-400"
            }`}
          >
            <div
              aria-hidden
              className="relative grid aspect-video place-items-center bg-[radial-gradient(circle_at_30%_20%,rgba(255,144,115,.25),transparent_55%),linear-gradient(135deg,#1c1617,#2a1f1d)]"
            >
              <span className="text-3xl text-brand-300">✎</span>
              {writing && <Check />}
            </div>
            <div className="flex flex-1 flex-col gap-1 bg-zinc-900/80 p-3">
              <span className="font-semibold leading-tight text-zinc-50">Your own idea</span>
              <span className="text-xs leading-snug text-zinc-400">Describe any change you can imagine</span>
            </div>
          </button>
        )}

        {shown.map((p) => {
          const selected = selectedId === p.id;
          return (
            // The wrapper carries hover/focus playback and hosts the touch play
            // control as a SIBLING of the card button (no button in a button).
            <div key={p.id} className="relative flex" {...previewHandlers(p.id)}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onPick(p.id)}
              className={`group relative flex w-full flex-col overflow-hidden rounded-2xl border text-left ${
                selected
                  ? "border-brand-400 ring-2 ring-brand-400"
                  : "border-zinc-800 hover:border-zinc-500"
              }`}
            >
              <div className="relative">
                <EffectArt preset={p} size="sm" className="transition-transform duration-300 motion-safe:group-hover:scale-[1.04]" />
                {selected && <Check />}
              </div>
              <div className="flex flex-1 flex-col gap-1 bg-zinc-900/80 p-3">
                <span className="font-semibold leading-tight text-zinc-50">{p.label}</span>
                <span className="line-clamp-2 text-xs leading-snug text-zinc-400">{p.pitch}</span>
                <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5">
                  <Intensity level={p.intensity} />
                  {p.needsImage && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        hasPhoto ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-400/15 text-amber-200"
                      }`}
                    >
                      {hasPhoto ? "Photo added ✓" : "Needs a photo"}
                    </span>
                  )}
                </span>
              </div>
            </button>
            <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
              <div className="absolute inset-0">
                <PreviewPlayButton id={p.id} label={p.label} />
              </div>
            </div>
            </div>
          );
        })}
      </div>
      {shown.length === 0 && !allowCustom && (
        <p className="rounded-2xl border border-dashed border-zinc-700 p-6 text-center text-zinc-300">
          {emptyText}
        </p>
      )}
    </div>
  );
}

function Check() {
  return (
    <span
      aria-hidden
      className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-brand-400 text-sm font-bold text-zinc-950 shadow-lg"
    >
      ✓
    </span>
  );
}
