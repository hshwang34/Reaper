// The streamer's control surface. Runs in a REAL Chrome tab (never inside OBS)
// because it needs getUserMedia on the OBS Virtual Camera. Holds the state
// machine, the camera, and the loopback sender; also exposes the guardrail
// settings and the panic control.

import { useEffect, useRef, useState } from "react";
import type { AnyMsg, RouterState, Settings, StatusSnapshot } from "@rh/shared";
import { PRESETS } from "@rh/shared";
import { api, type RouterConfig } from "../lib/api.js";
import { HubSocket } from "../lib/ws.js";
import { LoopbackSender } from "../lib/loopback.js";
import { RouterMachine } from "./stateMachine.js";
import { acquireCamera } from "./decartSession.js";

const STATE_COLOR: Record<RouterState, string> = {
  OFFLINE: "bg-zinc-600",
  ARMING: "bg-amber-500",
  IDLE: "bg-emerald-600",
  AUTHORIZING: "bg-sky-500",
  CONNECTING: "bg-sky-500",
  BUFFERING: "bg-indigo-500",
  LIVE: "bg-fuchsia-600",
  TEARDOWN: "bg-amber-500",
  ERROR: "bg-red-600",
};

export default function RouterPage() {
  const machineRef = useRef<RouterMachine | null>(null);
  const hubRef = useRef<HubSocket | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const aiPreviewRef = useRef<HTMLVideoElement>(null);

  const [state, setState] = useState<RouterState>("OFFLINE");
  const [remaining, setRemaining] = useState<number | undefined>();
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [cfg, setCfg] = useState<RouterConfig | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [armError, setArmError] = useState<string | null>(null);

  const pushLog = (line: string) =>
    setLogLines((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 40));

  useEffect(() => {
    const hub = new HubSocket("router").connect();
    hubRef.current = hub;
    const sender = new LoopbackSender(hub);
    const machine = new RouterMachine(hub, sender, {
      onState: (s, rem) => {
        setState(s);
        setRemaining(rem);
      },
      log: pushLog,
      onAiStream: (stream) => {
        if (aiPreviewRef.current) {
          aiPreviewRef.current.srcObject = stream;
          if (stream) void aiPreviewRef.current.play().catch(() => {});
        }
      },
    });
    machineRef.current = machine;

    const off = hub.on((m) => {
      const msg = m as AnyMsg;
      switch (msg.t) {
        case "job:start":
          void machine.runJob(msg.job);
          break;
        case "job:cancel":
          machine.cancel(msg.jobId, msg.reason);
          break;
        case "viewer:frames-ok":
          machine.onFramesOk(msg.jobId);
          break;
        case "status":
          setStatus(msg.status);
          break;
      }
    });

    api.getRouterConfig().then(setCfg).catch(() => {});

    // Panic hotkey: Escape toggles pause on the sidecar (which cancels any
    // active job). The streamer's face is the canvas — this must be instant.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void panic();
    };
    window.addEventListener("keydown", onKey);
    const onUnload = () => machine.dispose();
    window.addEventListener("pagehide", onUnload);

    return () => {
      off();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onUnload);
      machine.dispose();
      hub.close();
    };
  }, []);

  async function arm() {
    setArmError(null);
    try {
      const { stream, usingObs } = await acquireCamera();
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        void previewRef.current.play().catch(() => {});
      }
      machineRef.current?.setCamera(stream);
      pushLog(
        usingObs
          ? "armed on OBS Virtual Camera"
          : "armed on default camera (OBS Virtual Camera not found)",
      );
    } catch (e) {
      setArmError((e as Error).message);
    }
  }

  async function panic() {
    const { paused } = await api.panic();
    pushLog(paused ? "PANIC — paused" : "resumed");
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Reality Hijack — Router</h1>
          <p className="text-sm text-zinc-400">
            Streamer control surface · capture + state machine
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-sm font-semibold ${STATE_COLOR[state]}`}
          >
            {state}
            {state === "LIVE" && remaining != null ? ` · ${remaining}s` : ""}
          </span>
          <button
            onClick={panic}
            className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-bold hover:bg-red-500"
            title="Esc"
          >
            PANIC
          </button>
        </div>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Left: camera + status */}
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="mb-1 text-xs text-zinc-500">Camera (input)</p>
              <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black">
                <video
                  ref={previewRef}
                  muted
                  playsInline
                  className="aspect-video w-full object-cover"
                />
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-zinc-500">AI output (Decart)</p>
              <div className="overflow-hidden rounded-xl border border-fuchsia-900 bg-black">
                <video
                  ref={aiPreviewRef}
                  muted
                  playsInline
                  className="aspect-video w-full object-cover"
                />
              </div>
            </div>
          </div>
          {!machineRef.current?.hasCamera() && state === "OFFLINE" && (
            <button
              onClick={arm}
              className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500"
            >
              Arm camera
            </button>
          )}
          {armError && (
            <p className="text-sm text-red-400">Arm failed: {armError}</p>
          )}

          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Info label="Decart" value={cfg ? (cfg.decartEnabled ? "LIVE" : "MOCK") : "…"} />
            <Info label="OBS" value={cfg ? (cfg.obsConnected ? "connected" : "waiting") : "…"} />
            <Info label="Queue" value={status ? String(status.queueLength) : "0"} />
            <Info label="Paused" value={status?.paused ? "yes" : "no"} />
          </dl>
        </section>

        {/* Right: guardrail settings + log */}
        <section className="space-y-4">
          <SettingsPanel onSaved={(s) => pushLog(`settings saved (min $${s.minTipUSD}, max ${s.maxDurationSec}s)`)} />
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Event log
            </h3>
            <div className="max-h-56 space-y-1 overflow-y-auto font-mono text-xs text-zinc-400">
              {logLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function SettingsPanel({ onSaved }: { onSaved: (s: Settings) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then(setS).catch(() => {});
  }, []);

  if (!s) return null;

  const patch = (p: Partial<Settings>) => setS({ ...s, ...p });
  const togglePreset = (id: string) =>
    patch({
      enabledPresetIds: s.enabledPresetIds.includes(id)
        ? s.enabledPresetIds.filter((x) => x !== id)
        : [...s.enabledPresetIds, id],
    });

  async function save() {
    if (!s) return;
    setSaving(true);
    try {
      const next = await api.saveSettings(s);
      setS(next);
      onSaved(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Guardrails
      </h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="space-y-1">
          <span className="text-zinc-400">Min tip ($)</span>
          <input
            type="number"
            min={1}
            value={s.minTipUSD}
            onChange={(e) => patch({ minTipUSD: Number(e.target.value) })}
            className="w-full rounded bg-zinc-900 px-2 py-1"
          />
        </label>
        <label className="space-y-1">
          <span className="text-zinc-400">Max duration (s)</span>
          <input
            type="number"
            min={1}
            value={s.maxDurationSec}
            onChange={(e) => patch({ maxDurationSec: Number(e.target.value) })}
            className="w-full rounded bg-zinc-900 px-2 py-1"
          />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={s.allowCustomPrompts}
          onChange={(e) => patch({ allowCustomPrompts: e.target.checked })}
        />
        <span className="text-zinc-300">Allow custom free-text prompts</span>
      </label>

      <div className="mt-3">
        <span className="text-xs text-zinc-500">Enabled presets</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => togglePreset(p.id)}
              className={`rounded-full px-3 py-1 text-xs ${
                s.enabledPresetIds.includes(p.id)
                  ? "bg-emerald-600"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {p.emoji} {p.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="mt-4 rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold hover:bg-sky-500 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
