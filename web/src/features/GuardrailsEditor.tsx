// The streamer's guardrail controls — ONE editor for both surfaces:
//   · the router page (local rig / Electron): edits a draft, explicit Save
//   · the hosted dashboard: autosaves each change
// The editor is controlled and policy-free: it renders `settings` and emits
// `onChange(patch)`; the host decides whether to buffer or persist. Number
// and list fields commit on blur/Enter (not per keystroke) so an autosaving
// host doesn't write half-typed values.
//
// The content-policy half mirrors docs/CONTENT-SAFETY.md S0: the streamer's
// knobs sit above a floor (nudity, minors, impersonation, gore) that no
// setting here can lower — the copy says so, so nobody thinks "standard"
// means "anything goes".

import { useEffect, useState } from "react";
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

export interface GuardrailsEditorProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** Column count for the numeric/toggle grid (dashboard is wider). */
  columns?: 2 | 4;
}

const CUSTOM_TIERS: { value: CustomPromptTier; label: string }[] = [
  { value: "off", label: "Off — presets only" },
  { value: "classified", label: "On — AI-moderated" },
  { value: "classified+approval", label: "On — moderated + I approve each one" },
];

const IMAGE_TIERS: { value: ReferenceImageTier; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "scenes", label: "Scenes & styles only (no faces)" },
  { value: "likeness", label: "Allow face swaps (with viewer consent)" },
];

const GUARD_MODES: { value: OutputGuardMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on", label: "On — stop the effect if the output looks unsafe" },
  { value: "required", label: "Required — no viewer content runs without it" },
];

const INTENSITY = ["", "Mild", "Gentle", "Lively", "Intense", "Wild"];

export function GuardrailsEditor({ settings: s, onChange, columns = 2 }: GuardrailsEditorProps) {
  const togglePreset = (id: string) =>
    onChange({
      enabledPresetIds: s.enabledPresetIds.includes(id)
        ? s.enabledPresetIds.filter((x) => x !== id)
        : [...s.enabledPresetIds, id],
    });
  const toggleCategory = (c: PresetCategory) =>
    onChange({
      allowedCategories: s.allowedCategories.includes(c)
        ? s.allowedCategories.filter((x) => x !== c)
        : [...s.allowedCategories, c],
    });

  return (
    <div>
      <div
        className={`grid gap-3 text-sm ${columns === 4 ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2"}`}
      >
        <NumberField
          label="Min tip ($)"
          value={s.minTipUSD}
          min={0}
          onCommit={(v) => onChange({ minTipUSD: v })}
        />
        <NumberField
          label="Max duration (s)"
          value={s.maxDurationSec}
          min={1}
          onCommit={(v) => onChange({ maxDurationSec: v })}
        />
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.allowSolePendingMatch}
          onChange={(e) => onChange({ allowSolePendingMatch: e.target.checked })}
        />
        <span className="text-zinc-300">
          Match unlabeled tips to the only pending request (single-viewer demo)
        </span>
      </label>

      {/* ── Content policy ─────────────────────────────────────────── */}
      <section className="mt-5 rounded-lg border border-zinc-800 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Content policy
        </h4>
        <p className="mt-1 text-xs text-zinc-500">
          Always blocked, whatever you pick: nudity or sexual content, anyone
          who may be under 18, real public figures, hate, gore, self-harm.
        </p>

        <div
          className={`mt-3 grid gap-3 text-sm ${columns === 4 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"}`}
        >
          <SelectField
            label="Viewers' own text prompts"
            value={s.customPrompts}
            options={CUSTOM_TIERS}
            onChange={(v) => onChange({ customPrompts: v })}
          />
          <SelectField
            label="Viewer photos"
            value={s.referenceImages}
            options={IMAGE_TIERS}
            onChange={(v) => onChange({ referenceImages: v })}
          />
          <SelectField
            label="Output safety guard (on this machine)"
            value={s.outputGuard}
            options={GUARD_MODES}
            onChange={(v) => onChange({ outputGuard: v })}
          />
          <SelectField
            label="Moderation strictness"
            value={s.moderationStrictness}
            options={[
              { value: "strict", label: "Strict — when unsure, block" },
              { value: "standard", label: "Standard — borderline goes to me" },
            ]}
            onChange={(v) => onChange({ moderationStrictness: v })}
          />
        </div>

        <label className="mt-3 block text-sm">
          <span className="text-zinc-400">
            Intensity ceiling:{" "}
            <span className="text-zinc-200">
              {s.maxIntensity} — {INTENSITY[s.maxIntensity]}
            </span>
          </span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={s.maxIntensity}
            onChange={(e) => onChange({ maxIntensity: Number(e.target.value) })}
            className="mt-1 w-full accent-sky-500"
          />
        </label>

        <div className="mt-2">
          <span className="text-xs text-zinc-500">Allowed kinds of effect</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {PRESET_CATEGORIES.map((c) => {
              const on = s.allowedCategories.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleCategory(c)}
                  className={`rounded-full px-3 py-1 text-xs capitalize ${
                    on ? "bg-sky-700" : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 space-y-2 text-sm">
          <Toggle
            checked={s.reviewLikeness}
            onChange={(v) => onChange({ reviewLikeness: v })}
            label="I approve every face swap before it runs"
          />
          <Toggle
            checked={s.enhanceCustomPrompts}
            onChange={(v) => onChange({ enhanceCustomPrompts: v })}
            label="Let the model rewrite viewers' text (less predictable — off is safer)"
          />
          <Toggle
            checked={s.showAttribution}
            onChange={(v) => onChange({ showAttribution: v })}
            label={'Show "hijacked by <name>" on stream'}
          />
          <Toggle
            checked={s.showAiLabel}
            onChange={(v) => onChange({ showAiLabel: v })}
            label={'Show an "AI-altered" label on stream (Kick requires one)'}
          />
        </div>

        <div
          className={`mt-3 grid gap-3 text-sm ${columns === 4 ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"}`}
        >
          <ListField
            label="Extra blocked words"
            placeholder="comma-separated"
            value={s.blocklistExtra}
            onCommit={(v) => onChange({ blocklistExtra: v })}
          />
          <ListField
            label="Banned viewers (tip names)"
            placeholder="comma-separated"
            value={s.bannedViewers}
            onCommit={(v) => onChange({ bannedViewers: v })}
          />
        </div>
      </section>

      <div className="mt-4">
        <span className="text-xs text-zinc-500">Enabled presets</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const on = s.enabledPresetIds.includes(p.id);
            // Enabled but excluded by the policy above: show why it won't appear.
            const blocked = on && !presetAllowed(p, s);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => togglePreset(p.id)}
                title={blocked ? "Hidden by your content policy" : undefined}
                className={`rounded-full px-3 py-1 text-xs ${
                  blocked
                    ? "bg-amber-900/60 text-amber-200 line-through"
                    : on
                      ? "bg-emerald-600"
                      : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {p.emoji} {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-zinc-300">{label}</span>
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-zinc-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full rounded bg-zinc-900 px-2 py-1"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Comma-separated list that commits on blur/Enter. */
function ListField({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
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
    <label className="space-y-1">
      <span className="text-zinc-400">{label}</span>
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded bg-zinc-900 px-2 py-1"
      />
    </label>
  );
}

/** Numeric input that commits on blur/Enter. Keeps its own text while
 *  focused so a half-typed "1" doesn't become the saved value; re-syncs from
 *  the prop when the host hands back a (possibly clamped) value. */
function NumberField({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
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
    <label className="space-y-1">
      <span className="text-zinc-400">{label}</span>
      <input
        type="number"
        min={min}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded bg-zinc-900 px-2 py-1"
      />
    </label>
  );
}
