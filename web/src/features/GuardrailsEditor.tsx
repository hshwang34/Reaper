// The streamer's guardrail controls — ONE editor for both surfaces:
//   · the router page (local rig / Electron): edits a draft, explicit Save
//   · the hosted dashboard: autosaves each change
// The editor is controlled and policy-free: it renders `settings` and emits
// `onChange(patch)`; the host decides whether to buffer or persist. Number
// fields commit on blur/Enter (not per keystroke) so an autosaving host
// doesn't write half-typed values.

import { useEffect, useState } from "react";
import { PRESETS, type Settings } from "@rh/shared";

export interface GuardrailsEditorProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** Column count for the numeric/toggle grid (dashboard is wider). */
  columns?: 2 | 4;
}

export function GuardrailsEditor({ settings: s, onChange, columns = 2 }: GuardrailsEditorProps) {
  const togglePreset = (id: string) =>
    onChange({
      enabledPresetIds: s.enabledPresetIds.includes(id)
        ? s.enabledPresetIds.filter((x) => x !== id)
        : [...s.enabledPresetIds, id],
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
          checked={s.allowCustomPrompts}
          onChange={(e) => onChange({ allowCustomPrompts: e.target.checked })}
        />
        <span className="text-zinc-300">Allow custom free-text prompts</span>
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.allowSolePendingMatch}
          onChange={(e) => onChange({ allowSolePendingMatch: e.target.checked })}
        />
        <span className="text-zinc-300">
          Match unlabeled tips to the only pending request (single-viewer demo)
        </span>
      </label>

      <div className="mt-3">
        <span className="text-xs text-zinc-500">Enabled presets</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const on = s.enabledPresetIds.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => togglePreset(p.id)}
                className={`rounded-full px-3 py-1 text-xs ${
                  on ? "bg-emerald-600" : "bg-zinc-800 text-zinc-400"
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
