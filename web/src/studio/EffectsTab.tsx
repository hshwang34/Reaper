// "What's possible": every effect viewers can buy, grouped by the kind of
// edit Lucy 2.5 makes (Decart's own prompt-guide categories), each with an
// on/off switch and a free preview on the streamer's own camera. Doubles as
// the first-run inspiration gallery — so it leads with what the effects DO,
// not with settings.

import { useState } from "react";
import { EDIT_TYPE_LABEL, PRESETS, presetAllowed, type EditType, type Preset, type Settings } from "@rh/shared";
import { CATEGORY_LABEL, EffectArt, Intensity } from "../features/EffectArt.js";
import { btn } from "./ui.js";

const ORDER: EditType[] = ["restyle", "background", "character", "attribute", "add", "vfx"];

/** Typed-idea starters — what a viewer can write beyond the gallery. */
const IDEAS = [
  { type: "Become someone", example: "Replace the character with a silver-armored space explorer" },
  { type: "Add something", example: "Add two macaw parrots perched on the person's shoulders" },
  { type: "Change an outfit", example: "Change the hoodie to a sharp black tuxedo" },
  { type: "New background", example: "Change the background to a beach at sunset" },
  { type: "Restyle everything", example: "Transform the scene into a Studio Ghibli painting" },
  { type: "Visual effects", example: "Add falling snow and frost on every surface" },
];

export function EffectsTab({
  settings,
  onChange,
  onTry,
  canTry,
  tryNote,
}: {
  settings: Settings | null;
  onChange: (patch: Partial<Settings>) => void;
  onTry: (p: Preset) => void;
  /** Camera armed and nothing playing. */
  canTry: boolean;
  tryNote: string;
}) {
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const on = (p: Preset) => !settings?.disabledPresetIds.includes(p.id);
  const visible = (p: Preset) => (filter === "all" ? true : filter === "on" ? on(p) : !on(p));
  const toggle = (p: Preset) =>
    settings &&
    onChange({
      disabledPresetIds: on(p)
        ? [...settings.disabledPresetIds, p.id]
        : settings.disabledPresetIds.filter((x) => x !== p.id),
    });
  const enabledCount = PRESETS.filter(on).length;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-50">What your viewers can do</h1>
          <p className="mt-1 max-w-2xl text-zinc-400">
            Viewers pick one of these, pay, and your camera transforms live on stream — $1 buys one second, then
            it snaps back. {enabledCount} of {PRESETS.length} effects are on.
          </p>
        </div>
        <div role="tablist" aria-label="Show" className="flex gap-1 rounded-xl bg-zinc-900 p-1 text-sm">
          {(["all", "on", "off"] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 ${filter === f ? "bg-zinc-700 font-semibold text-white" : "text-zinc-400"}`}
            >
              {f === "all" ? "All" : f === "on" ? "On" : "Off"}
            </button>
          ))}
        </div>
      </header>

      {ORDER.map((type) => {
        const list = PRESETS.filter((p) => p.editType === type && visible(p));
        if (!list.length) return null;
        return (
          <section key={type} aria-labelledby={`et-${type}`}>
            <h2 id={`et-${type}`} className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
              {EDIT_TYPE_LABEL[type]}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((p) => (
                <EffectCard
                  key={p.id}
                  preset={p}
                  on={on(p)}
                  hiddenByRules={Boolean(settings) && on(p) && !presetAllowed(p, settings!)}
                  onToggle={() => toggle(p)}
                  onTry={() => onTry(p)}
                  canTry={canTry}
                  tryNote={tryNote}
                />
              ))}
            </ul>
          </section>
        );
      })}

      <section className="rounded-2xl border border-dashed border-white/15 p-6">
        <h2 className="text-lg font-semibold text-zinc-100">…or viewers write their own</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          With typed ideas on (Safety tab), viewers can describe any change. Every idea is screened before it reaches
          your stream. The best ones describe one change, say where it goes, and use concrete words:
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {IDEAS.map((i) => (
            <li key={i.type} className="rounded-xl bg-zinc-900/80 p-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-brand-400">{i.type}</span>
              <p className="mt-1 text-sm text-zinc-200">“{i.example}”</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function EffectCard({
  preset: p,
  on,
  hiddenByRules,
  onToggle,
  onTry,
  canTry,
  tryNote,
}: {
  preset: Preset;
  on: boolean;
  hiddenByRules: boolean;
  onToggle: () => void;
  onTry: () => void;
  canTry: boolean;
  tryNote: string;
}) {
  return (
    <li
      className={`overflow-hidden rounded-2xl border bg-zinc-950 transition-opacity ${
        on ? "border-white/10" : "border-white/5 opacity-60"
      }`}
    >
      <div className="relative">
        <EffectArt preset={p} />
        <span className="absolute left-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-xs text-zinc-200 backdrop-blur">
          {CATEGORY_LABEL[p.category]}
        </span>
        {p.needsImage && (
          <span className="absolute right-3 top-3 rounded-full bg-black/55 px-2 py-0.5 text-xs text-zinc-200 backdrop-blur">
            Needs a photo
          </span>
        )}
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-zinc-50">{p.label}</h3>
            <p className="text-sm text-zinc-400">{p.pitch}</p>
          </div>
          <Intensity level={p.intensity} />
        </div>
        {hiddenByRules && (
          <p className="text-xs text-amber-300">Hidden from viewers by your Safety rules.</p>
        )}
        <div className="flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
            <span className="relative inline-flex">
              <input
                type="checkbox"
                role="switch"
                aria-label={`${p.label} available to viewers`}
                checked={on}
                onChange={onToggle}
                className="peer sr-only"
              />
              <span className="h-5 w-9 rounded-full bg-zinc-700 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400" />
              <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
            </span>
            {on ? "On" : "Off"}
          </label>
          <button
            type="button"
            onClick={onTry}
            disabled={!canTry || (p.needsImage ?? false)}
            title={p.needsImage ? "Needs a viewer's photo — can't be previewed" : canTry ? undefined : tryNote}
            className={btn.ghost + " disabled:cursor-not-allowed disabled:opacity-40"}
          >
            ▶ Try on me
          </button>
        </div>
      </div>
    </li>
  );
}
