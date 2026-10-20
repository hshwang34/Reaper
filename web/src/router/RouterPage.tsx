// The streamer's studio — the app's home after setup. Runs in a REAL Chrome
// tab / the Electron window (never inside OBS) because it needs getUserMedia
// on the OBS Virtual Camera. The router wiring itself (hub, state machine,
// camera, loopback) is useRouterEngine; this page is the streamer-facing
// surface over it: am I live-ready, where is panic, what do I share, and —
// for the curious — the guardrails, moderation and developer panels.

import { useEffect, useState } from "react";
import type { RouterState, Settings } from "@rh/shared";
import { api } from "../lib/api.js";
import { desktopBridge } from "../lib/desktop.js";
import { PANIC_KEY, TRAY_NAME } from "../lib/platform.js";
import { GuardrailsEditor } from "../features/GuardrailsEditor.js";
import { DesktopCredentials } from "../features/DesktopCredentials.js";
import { ModerationPanel, ReviewPanel } from "../features/SafetyPanels.js";
import { Keycap } from "../features/Keycap.js";
import { StreamVideo, useRouterEngine } from "./useRouterEngine.js";

const STATE_COLOR: Record<RouterState, string> = {
  OFFLINE: "bg-zinc-600",
  IDLE: "bg-emerald-600",
  AUTHORIZING: "bg-sky-500",
  CONNECTING: "bg-sky-500",
  BUFFERING: "bg-indigo-500",
  LIVE: "bg-brand-600",
  TEARDOWN: "bg-amber-500",
};

/** What the state pill says to a streamer (the raw state stays in its title). */
const STATE_LABEL: Record<RouterState, string> = {
  OFFLINE: "Camera off",
  IDLE: "Ready",
  AUTHORIZING: "Starting…",
  CONNECTING: "Connecting…",
  BUFFERING: "Warming up…",
  LIVE: "LIVE",
  TEARDOWN: "Reverting…",
};

export default function RouterPage() {
  const r = useRouterEngine();
  const desktop = desktopBridge();
  const [login, setLogin] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string>(`${location.origin}/portal`);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void desktop?.setupState().then((s) => {
      setLogin(s.login);
      if (s.portalUrl) setPortalUrl(s.portalUrl);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const paused = r.status?.paused ?? false;
  const armed = r.cameraStream !== null;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Creator studio</h1>
          <p className="text-sm text-zinc-400">
            {login ? (
              <>
                Signed in as <b className="text-zinc-200">{login}</b> ·{" "}
              </>
            ) : null}
            Keep this window open while you stream — it's what runs each hijack.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            title={r.state}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${STATE_COLOR[r.state]}`}
          >
            {STATE_LABEL[r.state]}
            {r.state === "LIVE" && r.remainingSec != null ? ` · ${r.remainingSec}s` : ""}
          </span>
          <PanicButton paused={paused} onClick={() => void r.panic()} />
        </div>
      </header>

      {/* Hero: the AI output is what the streamer is judging, so it gets the
          full width; the camera input is just an "am I armed?" inset. */}
      <div className="relative mb-6 overflow-hidden rounded-xl border border-brand-900 bg-black">
        <p className="absolute left-3 top-2 z-10 text-xs text-zinc-400">
          {r.aiStream ? "AI output — this is what viewers see" : "AI output appears here during a hijack"}
        </p>
        <StreamVideo stream={r.aiStream} className="aspect-video w-full object-contain" />
        <div className="absolute bottom-3 right-3 w-48 overflow-hidden rounded-lg border border-zinc-700 bg-black shadow-lg">
          <StreamVideo stream={r.cameraStream} className="aspect-video w-full object-cover" />
          <p className="absolute left-1.5 top-1 text-[10px] text-zinc-400">
            {r.camera ? r.camera.label : "Camera"}
          </p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Left: readiness, share link, panic explainer */}
        <section className="space-y-4">
          {!armed && r.state === "OFFLINE" && (
            <button
              onClick={() => void r.arm()}
              className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500"
            >
              Turn the camera on
            </button>
          )}
          {r.cams.length > 0 && (r.state === "IDLE" || r.state === "OFFLINE") && (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Camera
              <select
                value={r.camId}
                onChange={(e) => r.switchCamera(e.target.value)}
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm"
              >
                <option value="auto">Auto (prefer OBS Virtual Camera)</option>
                {r.cams.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {r.camera && !r.camera.usingObs && (
            <p className="text-sm text-amber-400">
              Using {r.camera.label}, not the OBS Virtual Camera — effects will restyle the
              raw webcam, not your OBS scene.
            </p>
          )}
          {r.armError && <p className="text-sm text-red-400">Camera failed: {r.armError}</p>}

          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Info label="Camera" value={armed ? (r.camera?.usingObs ? "OBS Virtual Camera" : "on") : "off"} />
            <Info label="OBS" value={r.cfg ? (r.cfg.obsConnected ? "connected" : "not connected") : "…"} />
            <Info label="AI model" value={r.cfg ? (r.cfg.decartEnabled ? "live" : "demo (passthrough)") : "…"} />
            <Info label="Queue" value={r.status ? `${r.status.queueLength} waiting` : "0"} />
          </dl>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Your viewer page
            </h3>
            <p className="mb-2 text-sm text-zinc-400">
              Put this in chat or a panel. Viewers write a prompt, add a photo, pay, and
              their hijack runs here.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-zinc-900 p-2 text-xs">{portalUrl}</code>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(portalUrl).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="rounded bg-zinc-800 px-3 py-2 text-xs hover:bg-zinc-700"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <PanicExplainer paused={paused} />
        </section>

        {/* Right: approvals + try-it + guardrails + moderation; dev panels collapsed */}
        <section className="space-y-4">
          <ReviewPanel client={api} pending={r.status?.reviewPending} />
          <TryEffectPanel
            armed={armed}
            busy={r.state !== "IDLE"}
            state={r.state}
            onFired={(outcome) => r.pushLog(`manual hijack → ${outcome}`)}
          />
          <SettingsPanel
            onSaved={(s) => {
              r.pushLog(`settings saved (min $${s.minTipUSD}, max ${s.maxDurationSec}s)`);
              if (s.outputGuard !== "off") r.warmGuard();
            }}
          />
          <ModerationPanel
            client={api}
            onBan={(name) =>
              void api
                .getSettings()
                .then((s) => api.saveSettings({ bannedViewers: [...s.bannedViewers, name] }))
                .then(() => r.pushLog(`banned ${name}`))
                .catch((e) => r.pushLog(`ban failed: ${(e as Error).message}`))
            }
          />
          <details className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Advanced — credentials
            </summary>
            <div className="mt-3">
              <DesktopCredentials />
            </div>
          </details>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Event log
            </h3>
            <div className="max-h-56 space-y-1 overflow-y-auto font-mono text-xs text-zinc-400">
              {r.logLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The one control that must never be ambiguous. Two states, both named. */
function PanicButton({ paused, onClick }: { paused: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${PANIC_KEY} from any app · Esc in this window`}
      className={`rounded-lg px-4 py-1.5 text-sm font-bold ${
        paused ? "bg-emerald-600 hover:bg-emerald-500" : "bg-red-600 hover:bg-red-500"
      }`}
    >
      {paused ? "Resume hijacks" : "PANIC — hide & pause"}
    </button>
  );
}

function PanicExplainer({ paused }: { paused: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${paused ? "border-amber-700 bg-amber-950/30" : "border-zinc-800 bg-zinc-950"}`}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Panic
      </h3>
      {paused ? (
        <p className="text-sm text-amber-200">
          Paused. The effect is hidden and new hijacks wait. Press <Keycap>{PANIC_KEY}</Keycap>{" "}
          again or click Resume when you're ready.
        </p>
      ) : (
        <p className="text-sm text-zinc-400">
          Press <Keycap>{PANIC_KEY}</Keycap> from any app (OBS included), use the {TRAY_NAME}, or the
          red button above. The effect disappears from your stream immediately and new hijacks
          are paused until you resume. On the hosted service, a viewer whose hijack never played is refunded.
        </p>
      )}
    </div>
  );
}

/** Streamer console: type a prompt, run a hijack on yourself — no tip, no
 *  viewer. Disabled until the camera is on; queues normally if a job is running. */
function TryEffectPanel({
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
    <div className="rounded-xl border border-brand-900/60 bg-zinc-950 p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-widest text-brand-400">
        Try an effect on yourself
      </h3>
      <p className="mb-2 text-xs text-zinc-500">
        Runs exactly like a viewer's hijack, on your stream, for free. Good for checking your
        OBS scene before going live.
      </p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="Describe the reality to impose…"
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-sm outline-none focus:border-brand-500"
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
          className="ml-auto rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-bold hover:bg-brand-700 disabled:opacity-40"
        >
          {sending ? "Starting…" : busy ? "Queue it" : "Run it"}
        </button>
      </div>
      {!armed && (
        <p className="mt-2 text-xs text-amber-400">
          Turn the camera on first — a hijack needs a live camera feed.
        </p>
      )}
      {busy && armed && (
        <p className="mt-2 text-xs text-zinc-500">
          A hijack is running ({STATE_LABEL[state as RouterState] ?? state}) — new ones join the queue.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
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

/** Guardrails for the local rig: edit a draft, then Save — the streamer
 *  typically adjusts several knobs at once before a stream, and a single
 *  POST keeps the sidecar's settings.json write atomic. */
function SettingsPanel({ onSaved }: { onSaved: (s: Settings) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setS).catch((e) => setError((e as Error).message));
  }, []);

  if (!s) return null;

  async function save() {
    if (!s) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveSettings(s);
      setS(next);
      onSaved(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Guardrails
      </h3>
      <GuardrailsEditor settings={s} onChange={(p) => setS({ ...s, ...p })} />
      <button
        onClick={save}
        disabled={saving}
        className="mt-4 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save settings"}
      </button>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
