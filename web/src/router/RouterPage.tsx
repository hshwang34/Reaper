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
import { acquireCamera, listCameras } from "./decartSession.js";

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
  const [cams, setCams] = useState<{ deviceId: string; label: string }[]>([]);
  const [camId, setCamId] = useState<string>("auto");
  const camStreamRef = useRef<MediaStream | null>(null);

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

  async function arm(deviceId?: string) {
    setArmError(null);
    try {
      const { stream, usingObs } = await acquireCamera(deviceId);
      // Re-arm path (picker change): release the previous device first.
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = stream;
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        void previewRef.current.play().catch(() => {});
      }
      machineRef.current?.setCamera(stream);
      pushLog(
        usingObs
          ? "armed on OBS Virtual Camera"
          : deviceId
            ? `armed on ${stream.getVideoTracks()[0]?.label ?? "selected camera"}`
            : "armed on default camera (OBS Virtual Camera not found)",
      );
      // Labels are visible now that permission is granted — populate picker.
      setCams(await listCameras());
    } catch (e) {
      setArmError((e as Error).message);
    }
  }

  /** Picker fallback for when the label match got the wrong device (or the
   *  streamer wants a different one). Only offered between jobs. */
  function switchCamera(id: string) {
    setCamId(id);
    void arm(id === "auto" ? undefined : id);
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
              onClick={() => void arm()}
              className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500"
            >
              Arm camera
            </button>
          )}
          {cams.length > 0 && (state === "IDLE" || state === "OFFLINE") && (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Camera
              <select
                value={camId}
                onChange={(e) => switchCamera(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm"
              >
                <option value="auto">Auto (prefer OBS Virtual Camera)</option>
                {cams.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
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

        {/* Right: manual fire + guardrail settings + log */}
        <section className="space-y-4">
          <ManualHijackPanel
            armed={state !== "OFFLINE" && state !== "ARMING"}
            busy={state !== "IDLE"}
            state={state}
            onFired={(outcome) => pushLog(`manual hijack → ${outcome}`)}
          />
          <SettingsPanel onSaved={(s) => pushLog(`settings saved (min $${s.minTipUSD}, max ${s.maxDurationSec}s)`)} />
          <AppKeysPanel />
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

/** Streamer console: type a prompt, fire a hijack directly — no tip, no chat.
 *  Disabled until the camera is armed; queues normally if a job is running. */
function ManualHijackPanel({
  armed,
  busy,
  state,
  onFired,
}: {
  armed: boolean;
  busy: boolean;
  state: string;
  onFired: (outcome: string) => void;
}) {
  const [prompt, setPrompt] = useState(
    "Transform the person into an ancient Egyptian mummy wrapped in tattered linen bandages, dim golden tomb lighting",
  );
  const [duration, setDuration] = useState(15);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fire() {
    if (!prompt.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.manualHijack(prompt.trim(), duration);
      onFired(res.outcome);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-xl border border-fuchsia-900/60 bg-zinc-950 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-fuchsia-400">
        Manual hijack
      </h3>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="Describe the reality to impose…"
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-sm outline-none focus:border-fuchsia-500"
      />
      <div className="mt-2 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Duration
          <input
            type="number"
            min={1}
            max={120}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-16 rounded bg-zinc-900 px-2 py-1"
          />
          s
        </label>
        <button
          onClick={fire}
          disabled={!armed || sending || !prompt.trim()}
          className="ml-auto rounded-lg bg-fuchsia-600 px-4 py-1.5 text-sm font-bold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          {sending ? "Firing…" : busy ? "Queue hijack" : "Fire hijack"}
        </button>
      </div>
      {!armed && (
        <p className="mt-2 text-xs text-amber-400">
          Arm the camera first — the hijack needs a live camera feed.
        </p>
      )}
      {busy && armed && (
        <p className="mt-2 text-xs text-zinc-500">
          A job is running ({state}) — new fires join the queue.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** Desktop-app credential panel — renders only inside the Electron shell
 *  (window.rhDesktop from the preload). Secrets are write-only: the app
 *  reports back booleans, never values, and empty fields leave stored
 *  secrets untouched. Saving relaunches so the bridge picks the keys up. */
interface RhDesktop {
  keysStatus(): Promise<Record<string, boolean>>;
  saveKeys(keys: Record<string, string>): Promise<void>;
  relaunch(): Promise<void>;
}

function AppKeysPanel() {
  const desktop = (window as { rhDesktop?: RhDesktop }).rhDesktop;
  const [status, setStatus] = useState<Record<string, boolean> | null>(null);
  const [form, setForm] = useState({
    decartApiKey: "",
    streamlabsToken: "",
    obsWsUrl: "",
    obsWsPassword: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    desktop?.keysStatus().then(setStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!desktop) return null;

  const field = (
    key: keyof typeof form,
    label: string,
    placeholder: string,
  ) => (
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
