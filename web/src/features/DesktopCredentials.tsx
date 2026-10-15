// Desktop-app credential panel — renders only inside the Electron shell
// (window.rhDesktop from the preload). Secrets are write-only: the app
// reports back booleans, never values, and empty fields leave stored
// secrets untouched. Saving relaunches so the bridge picks the keys up.
//
// Lives here, not in the router page, because it is an Electron local-mode
// concern (pasted keys) that disappears entirely in cloud mode — the router
// page only mounts it.

import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop.js";

const EMPTY = {
  decartApiKey: "",
  streamlabsToken: "",
  obsWsUrl: "",
  obsWsPassword: "",
};

export function DesktopCredentials() {
  const desktop = desktopBridge();
  const [status, setStatus] = useState<Record<string, boolean> | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    desktop?.keysStatus().then(setStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!desktop) return null;

  const field = (key: keyof typeof EMPTY, label: string, placeholder: string) => (
    <label className="space-y-1">
      <span className="flex items-center gap-2 text-zinc-400">
        {label}
        {status && (
          <span
            className={`rounded-full px-1.5 text-[10px] ${status[key] ? "bg-emerald-700" : "bg-zinc-700"}`}
          >
            {status[key] ? "set" : "not set"}
          </span>
        )}
      </span>
      <input
        type="password"
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded bg-zinc-900 px-2 py-1"
      />
    </label>
  );

  async function save() {
    if (!desktop) return;
    setSaving(true);
    try {
      await desktop.saveKeys(form);
      await desktop.relaunch();
    } finally {
      setSaving(false);
    }
  }

  const dirty = Object.values(form).some((v) => v.trim());

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        App credentials
      </h3>
      <p className="mb-3 text-xs text-zinc-500">
        Stored in your OS keychain. Leave a field blank to keep its current
        value. (These disappear once accounts go live — the hosted service
        will hold the keys.)
      </p>
      <div className="grid grid-cols-2 gap-3 text-sm">
        {field("decartApiKey", "Decart API key", "dct_…")}
        {field("streamlabsToken", "Streamlabs socket token", "eyJ…")}
        {field("obsWsUrl", "OBS WebSocket URL", "auto-discovered")}
        {field("obsWsPassword", "OBS WebSocket password", "auto-discovered")}
      </div>
      <button
        onClick={() => void save()}
        disabled={!dirty || saving}
        className="mt-4 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save & restart app"}
      </button>
    </div>
  );
}
