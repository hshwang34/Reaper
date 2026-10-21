// The streamer's Rules — ONE editor for the studio and the hosted
// dashboard. Controlled and policy-free: it renders `settings` and emits
// `onChange(patch)`; both hosts autosave each change.
//
// Progressive disclosure: a streamer picks one of three levels (each a
// bundle of the underlying knobs) and only opens the details if they want
// to. Vendor names, enum values and classifier jargon never appear — the
// copy talks about what chat can and can't do. The hard floor (nudity,
// minors, real people, hate, gore) sits below every setting and says so.

import { useEffect, useState, type ReactNode } from "react";
import {
  PRESET_CATEGORIES,
  PRESETS,
  presetAllowed,
  type CustomPromptTier,
  type OutputGuardMode,
  type PresetCategory,
  type ReferenceImageTier,
  type Settings,
} from "@rh/shared";
import { CATEGORY_LABEL } from "./EffectArt.js";
import { Segmented, Switch, UndoToast, useUndo } from "../studio/ui.js";

type Level = "family" | "balanced" | "anything";

const LEVELS: { id: Level; label: string; blurb: string; patch: Partial<Settings> }[] = [
  {
    id: "family",
    label: "Family-friendly",
    blurb: "Only effects from your list. No custom effects, no photos, nothing intense.",
    patch: { customPrompts: "off", referenceImages: "off", maxIntensity: 3, allowedCategories: [...PRESET_CATEGORIES] },
  },
  {
    id: "balanced",
    label: "Balanced",
    blurb: "Your list plus custom effects. Photos of places and things, but no face swaps.",
    patch: { customPrompts: "classified", referenceImages: "scenes", maxIntensity: 4, allowedCategories: [...PRESET_CATEGORIES] },
  },
  {
    id: "anything",
    label: "Anything goes",
    blurb: "Everything on: custom effects, face swaps from a photo, the wildest effects.",
    patch: { customPrompts: "classified", referenceImages: "likeness", maxIntensity: 5, allowedCategories: [...PRESET_CATEGORIES] },
  },
];

function levelOf(s: Settings): Level | null {
  for (const l of LEVELS) {
    const p = l.patch;
    if (
      s.customPrompts === p.customPrompts &&
      s.referenceImages === p.referenceImages &&
      s.maxIntensity === p.maxIntensity &&
      s.allowedCategories.length === PRESET_CATEGORIES.length
    ) {
      return l.id;
    }
  }
  return null;
}

const TYPED: { value: CustomPromptTier; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Chat can only pick from your effects." },
  { value: "classified", label: "On", hint: "Chat can write their own idea. We check every one before it reaches you." },
  { value: "classified+approval", label: "I approve each", hint: "Custom effects wait for your OK in the Live tab. Chat is refunded if you decline." },
];
const PHOTOS: { value: ReferenceImageTier; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No photo uploads." },
  { value: "scenes", label: "Scenes & objects", hint: "Photos of places, styles and things. Photos with faces are refused." },
  { value: "likeness", label: "Faces too", hint: "Chat can turn you into someone in a photo, after confirming they have consent." },
];
const GUARD: { value: OutputGuardMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Requests are checked before they run. The result isn't watched." },
  { value: "on", label: "On", hint: "Also watches the effect on your computer and stops it if it looks unsafe." },
  { value: "required", label: "Required", hint: "Custom effects only run while this check is working." },
];
const WILD = ["", "Mild", "Gentle", "Lively", "Intense", "Wild"];

export function SafetyEditor({
  settings: s,
  onChange,
  local = false,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** The offline demo rig (no hosted account) — shows its one extra knob. */
  local?: boolean;
}) {
  const level = levelOf(s);
  const { undo, offer, clear } = useUndo();
  /** Picking a level REPLACES the details below, so keep the way back: the
   *  values of exactly the knobs it overwrites, offered for six seconds. */
  const choose = (l: (typeof LEVELS)[number]) => {
    if (level === l.id) return;
    const before = Object.fromEntries(Object.keys(l.patch).map((k) => [k, s[k as keyof Settings]])) as Partial<Settings>;
    onChange(l.patch);
    offer(`Switched to ${l.label}.`, () => onChange(before));
  };
  const unban = (name: string) => {
    const before = s.bannedViewers;
    onChange({ bannedViewers: before.filter((x) => x !== name) });
    offer(`Unbanned ${name}.`, () => onChange({ bannedViewers: before }));
  };
  const available = PRESETS.filter((p) => presetAllowed(p, s)).length;
  const toggleCategory = (c: PresetCategory) =>
    onChange({
      allowedCategories: s.allowedCategories.includes(c)
        ? s.allowedCategories.filter((x) => x !== c)
        : [...s.allowedCategories, c],
    });

  return (
    <div className="space-y-4">
      {/* ── Level ──────────────────────────────────────────────────── */}
      <div role="radiogroup" aria-label="Rules" className="grid gap-3 sm:grid-cols-3">
        {LEVELS.map((l) => {
          const on = level === l.id;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(l)}
              className={`rounded-2xl border p-4 text-left transition-colors ${
                on ? "border-brand-500 bg-brand-600/15" : "border-white/10 bg-zinc-900/60 hover:border-white/25"
              }`}
            >
              <span className="flex items-center justify-between">
                <span className="font-semibold text-zinc-100">{l.label}</span>
                <span
                  aria-hidden
                  className={`h-4 w-4 rounded-full border-2 ${on ? "border-brand-400 bg-brand-500" : "border-zinc-600"}`}
                />
              </span>
              <span className="mt-1.5 block text-sm leading-snug text-zinc-400">{l.blurb}</span>
            </button>
          );
        })}
      </div>
      {level === null && (
        <p className="text-sm text-zinc-400">
          <span className="font-semibold text-zinc-200">Custom rules.</span> Pick a level above to replace them, or keep
          adjusting below.
        </p>
      )}
      <p className="rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
        <span className="font-semibold">Our safety checks are always on.</span> Nudity, anyone who may be under 18,
        real public figures, hate, gore and self-harm are blocked whatever you choose here.
      </p>

      {/* ── Details ────────────────────────────────────────────────── */}
      <Section title="What chat can do" open>
        <Segmented label="Custom effects" value={s.customPrompts} options={TYPED} onChange={(v) => onChange({ customPrompts: v })} />
        <Segmented label="Photos" value={s.referenceImages} options={PHOTOS} onChange={(v) => onChange({ referenceImages: v })} />
        <Switch
          checked={s.showAttribution}
          onChange={(v) => onChange({ showAttribution: v })}
          label="Show who paid on stream"
          hint="A small name tag while their effect plays."
        />
        <Switch
          checked={s.showAiLabel}
          onChange={(v) => onChange({ showAiLabel: v })}
          label={'Show an "AI" label on stream'}
          hint="Required on some platforms (e.g. Kick) for realistic AI edits."
        />
      </Section>

      <Section title="How wild" summary={`${WILD[s.maxIntensity]} · ${available} of ${PRESETS.length} effects`}>
        <label className="block py-2">
          <span className="flex items-center justify-between text-sm">
            <span className="text-zinc-100">Wildest effect allowed</span>
            <span className="font-semibold text-zinc-200">{WILD[s.maxIntensity]}</span>
          </span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={s.maxIntensity}
            aria-valuetext={WILD[s.maxIntensity]}
            onChange={(e) => onChange({ maxIntensity: Number(e.target.value) })}
            className="mt-2 w-full accent-[#bb321b]"
          />
          <span className="flex justify-between text-sm text-zinc-400">
            <span>Mild</span>
            <span>Wild</span>
          </span>
        </label>
        <div className="py-2">
          <span className="text-sm text-zinc-100">Kinds of effects</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESET_CATEGORIES.map((c) => {
              const on = s.allowedCategories.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleCategory(c)}
                  className={`min-h-11 rounded-full px-4 py-1.5 text-sm ${
                    on ? "bg-zinc-100 font-semibold text-zinc-900" : "bg-zinc-800 text-zinc-400 line-through"
                  }`}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-sm text-zinc-400">Turn single effects on or off in the Effects tab.</p>
      </Section>

      <Section title="Price & length" summary={`From $${s.minTipUSD} · up to ${s.maxDurationSec}s`}>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <NumberField
            label="Lowest price ($)"
            hint="Every dollar buys one second."
            value={s.minTipUSD}
            min={1}
            onCommit={(v) => onChange({ minTipUSD: v })}
          />
          <NumberField
            label="Longest effect (seconds)"
            hint="Bigger payments are capped at this."
            value={s.maxDurationSec}
            min={1}
            onCommit={(v) => onChange({ maxDurationSec: v })}
          />
        </div>
      </Section>

      <Section
        title="Blocked words & people"
        summary={`${s.blocklistExtra.length} words · ${s.bannedViewers.length} banned`}
      >
        <ListField
          label="Extra blocked words"
          hint="Custom effects with these words are refused. Separate with commas."
          value={s.blocklistExtra}
          onCommit={(v) => onChange({ blocklistExtra: v })}
        />
        <div className="py-2">
          <span className="text-sm text-zinc-100">Banned people</span>
          {s.bannedViewers.length === 0 ? (
            <p className="mt-1 text-sm text-zinc-400">
              Nobody banned yet. You can ban someone from the Recently blocked list.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {s.bannedViewers.map((v) => (
                <span key={v} className="inline-flex items-center gap-1 rounded-full bg-zinc-800 pl-4 pr-1 text-sm">
                  {v}
                  <button
                    type="button"
                    aria-label={`Unban ${v}`}
                    onClick={() => unban(v)}
                    className="grid h-11 w-11 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title="Advanced">
        <Switch
          checked={s.reviewLikeness}
          onChange={(v) => onChange({ reviewLikeness: v })}
          label="I approve every face swap"
          hint="Face swaps wait for your OK in the Live tab."
        />
        <Switch
          checked={s.moderationStrictness === "strict"}
          onChange={(v) => onChange({ moderationStrictness: v ? "strict" : "standard" })}
          label="Strict safety checks"
          hint="When a custom effect is borderline, refuse it instead of letting it through."
        />
        <Switch
          checked={s.enhanceCustomPrompts}
          onChange={(v) => onChange({ enhanceCustomPrompts: v })}
          label="Let the AI add detail to custom effects"
          hint="Often looks better, but it can differ from what chat wrote."
        />
        <Segmented label="Live safety check" value={s.outputGuard} options={GUARD} onChange={(v) => onChange({ outputGuard: v })} />
        {local && (
          <Switch
            checked={s.allowSolePendingMatch}
            onChange={(v) => onChange({ allowSolePendingMatch: v })}
            label="Demo rig: give an unlabeled tip to the only waiting request"
          />
        )}
      </Section>
      <UndoToast undo={undo} onClose={clear} />
    </div>
  );
}

function Section({
  title,
  summary,
  open,
  children,
}: {
  title: string;
  summary?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="group rounded-2xl border border-white/10 bg-zinc-950/70">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-zinc-100">{title}</span>
        <span className="flex items-center gap-3 text-sm text-zinc-400">
          {summary}
          <span aria-hidden className="transition-transform group-open:rotate-180">
            ⌄
          </span>
        </span>
      </summary>
      <div className="divide-y divide-white/5 px-5 pb-4">{children}</div>
    </details>
  );
}

/** Comma-separated list that commits on blur/Enter. */
function ListField({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string[];
  onCommit: (v: string[]) => void;
}) {
  const joined = value.join(", ");
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  const commit = () => {
    const next = text
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    if (next.join(", ") !== joined) onCommit(next);
  };
  return (
    <label className="block py-2">
      <span className="text-sm text-zinc-100">{label}</span>
      <input
        value={text}
        placeholder="e.g. spider, clown"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="mt-2 w-full rounded-xl border border-white/10 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-brand-500"
      />
      <span className="mt-1 block text-sm text-zinc-400">{hint}</span>
    </label>
  );
}

/** Numeric input that commits on blur/Enter (an autosaving host must never
 *  write a half-typed value). Re-syncs when the host hands back a clamp. */
function NumberField({
  label,
  hint,
  value,
  min,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) return setText(String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <label className="block">
      <span className="text-sm text-zinc-100">{label}</span>
      <input
        type="number"
        min={min}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="mt-2 w-full rounded-xl border border-white/10 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-brand-500"
      />
      <span className="mt-1 block text-sm text-zinc-400">{hint}</span>
    </label>
  );
}
