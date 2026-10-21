// The Creator studio — the streamer's control surface. Runs in a REAL Chrome
// tab or the desktop app's window (never inside OBS) because it needs
// getUserMedia on the OBS Virtual Camera. It holds the state machine, the
// camera, and the loopback sender (the machinery below is unchanged: one job
// at a time, every exit through teardown()); everything visible is a
// streamer's tool, in four tabs:
//
//   Live      turn on, see what's playing, approve, preview an effect, stop
//   Effects   what's possible — the effects chat buys from, with switches
//   Rules     what chat may do: a level, then details on demand
//   Earnings  payouts + recent hijacks (hosted dashboard for the rest)
//
// In cloud mode the settings / approvals / safety log / earnings calls are
// answered by the hosted channel through the local bridge (sidecar cloudApi).

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PRESETS,
  PRESETS_BY_ID,
  presetAllowed,
  type AnyMsg,
  type HijackJob,
  type Preset,
  type RouterState,
  type Settings,
  type StatusSnapshot,
} from "@rh/shared";
import { api, type PayoutsInfo, type RouterConfig } from "../lib/api.js";
import { friendlyStreamerError } from "../lib/friendlyError.js";
import { PANIC_KEY } from "../lib/platform.js";
import { HubSocket } from "../lib/ws.js";
import { LoopbackSender } from "../lib/loopback.js";
import { desktopBridge } from "../lib/desktop.js";
import { SafetyEditor } from "../features/SafetyEditor.js";
import { ModerationPanel, ReviewPanel } from "../features/SafetyPanels.js";
import { EffectArt, PreviewPlayButton, previewHandlers } from "../features/EffectArt.js";
import { EffectsTab } from "../studio/EffectsTab.js";
import { EarningsTab } from "../studio/EarningsTab.js";
import { FirstRunTour, tourSeen } from "../studio/FirstRunTour.js";
import { Card, ConfirmDialog, ErrorCard, StatusChip, btn, statusOf } from "../studio/ui.js";
import { RouterMachine } from "./stateMachine.js";
import { browserPorts } from "./ports.js";
import { FrameGuard } from "./frameGuard.js";
import { acquireCamera, listCameras } from "./decartSession.js";
import { setDebugSink } from "../lib/debug.js";

type Tab = "live" | "effects" | "safety" | "earnings";
const TABS: { id: Tab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "effects", label: "Effects" },
  { id: "safety", label: "Rules" },
  { id: "earnings", label: "Earnings" },
];

/** Free previews are 10s on the hosted plane (server-chosen); match locally. */
const PREVIEW_SEC = 10;

/** Quiet retries (1.5 s apart) before a settings load failure is shown. */
const SETTINGS_RETRIES = 6;

/** Shown when a camera failure isn't one friendlyStreamerError knows. */
const CAMERA_FALLBACK = "Couldn't open the camera. Check that OBS is open and its Virtual Camera is started, then try again.";

export default function RouterPage() {
  const machineRef = useRef<RouterMachine | null>(null);
  const hubRef = useRef<HubSocket | null>(null);
  const guardRef = useRef<FrameGuard | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const aiPreviewRef = useRef<HTMLVideoElement>(null);

  const [tab, setTab] = useState<Tab>("live");
  const [touring, setTouring] = useState(() => !tourSeen());
  const [state, setState] = useState<RouterState>("OFFLINE");
  const [remaining, setRemaining] = useState<number | undefined>();
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  /** The stop switch's own answer. In cloud mode the pause lives on the
   *  hosted engine and the local hub's status broadcasts don't carry it, so
   *  the reply is the source of truth until a status says otherwise. */
  const [pausedByMe, setPausedByMe] = useState<boolean | null>(null);
  const [cfg, setCfg] = useState<RouterConfig | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  /** The studio's settings load failed — Rules/Effects show a Try again, not a forever-spinner. */
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** Hosted only: has Stripe cleared this streamer to take payments? */
  const [payouts, setPayouts] = useState<PayoutsInfo | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [armed, setArmed] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);
  const [cams, setCams] = useState<{ deviceId: string; label: string }[]>([]);
  const [camId, setCamId] = useState<string>("auto");
  const [camLabel, setCamLabel] = useState<string | null>(null);
  const [job, setJob] = useState<HijackJob | null>(null);
  const [guardReady, setGuardReady] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [picking, setPicking] = useState(false);
  const camStreamRef = useRef<MediaStream | null>(null);
  /** Read by the Esc handler (registered once) — is an effect on air? */
  const busyRef = useRef(false);

  const flash = (text: string, tone: "ok" | "bad" = "ok") => {
    setToast({ text, tone });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3500);
  };
  /** (Re)load the rules. In the desktop app the first calls can land while the
   *  link to the hosted channel is still coming up, so a failure is retried
   *  quietly a few times (the skeleton stays up) before it becomes a Try again
   *  card — never swallowed, never an endless "Loading…". */
  const loadSettings = (attempt = 0) => {
    if (attempt === 0) setSettingsError(null);
    api
      .getSettings()
      .then((s) => {
        setSettingsError(null);
        setSettings(s);
        // The live safety check is opt-in: warm it now so the first guarded
        // hijack doesn't spend its pre-LIVE budget loading; never download it when off.
        if (s.outputGuard !== "off") void guardRef.current?.ready();
      })
      .catch((e) => {
        if (attempt < SETTINGS_RETRIES) window.setTimeout(() => loadSettings(attempt + 1), 1500);
        else setSettingsError(`We couldn't load your rules. ${friendlyStreamerError(e)}`);
      });
  };
  /** Diagnostics go to the app's log (terminal / log file), not the screen. */
  const pushLog = (line: string) => hubRef.current?.send({ t: "page:log", line });

  useEffect(() => {
    const hub = new HubSocket("router").connect();
    hubRef.current = hub;
    setDebugSink((line) => hub.send({ t: "page:log", line }));
    const sender = new LoopbackSender(hub);
    // The live safety check (CONTENT-SAFETY S4, "output guard" in code) is opt-in.
    const guard = new FrameGuard((line) => {
      pushLog(line);
      if (/output guard ready/.test(line)) setGuardReady(true);
    });
    guardRef.current = guard;
    loadSettings();
    const machine = new RouterMachine(browserPorts(hub, sender, guard), {
      onState: (s, rem) => {
        busyRef.current = s !== "IDLE" && s !== "OFFLINE";
        setState(s);
        setRemaining(rem);
        if (s === "IDLE" || s === "OFFLINE") setJob(null);
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
    const offDrop = hub.onDrop(() => machine.abandon("lost connection to the app"));

    const off = hub.on((m) => {
      const msg = m as AnyMsg;
      switch (msg.t) {
        case "job:start":
          setJob(msg.job);
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
          if (msg.status.paused) setPausedByMe(null);
          break;
      }
    });

    // The OBS line must track the live connection (OBS is often launched
    // after this page, and can drop mid-stream), so poll the cheap local
    // config endpoint rather than fetching it once at mount.
    const refreshCfg = () => api.getRouterConfig().then(setCfg).catch(() => {});
    void refreshCfg();
    const cfgTimer = window.setInterval(refreshCfg, 5000);

    // Panic hotkey: Escape toggles pause (which cancels any active job).
    // The streamer's face is the canvas — this must be instant. While an
    // effect is on air Esc ALWAYS stops it, even over an open dialog; with
    // nothing playing, Esc in a dialog just closes the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!busyRef.current && document.querySelector("[aria-modal='true']")) return;
      void panic();
    };
    window.addEventListener("keydown", onKey);
    const onUnload = () => void machine.dispose();
    window.addEventListener("pagehide", onUnload);

    return () => {
      off();
      offDrop();
      setDebugSink(null);
      window.clearInterval(cfgTimer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onUnload);
      void machine.dispose();
      sender.dispose();
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
      setArmed(true);
      const label = usingObs ? "OBS Virtual Camera" : (stream.getVideoTracks()[0]?.label ?? "Camera");
      setCamLabel(label);
      pushLog(usingObs ? "armed on OBS Virtual Camera" : `armed on ${label} (OBS Virtual Camera not found)`);
      // Labels are visible now that permission is granted — populate picker.
      setCams(await listCameras());
    } catch (e) {
      const m = friendlyStreamerError(e);
      // friendlyStreamerError's catch-all is a server-side apology; a camera failure deserves the OBS hint.
      setArmError(/went wrong on our side/i.test(m) ? CAMERA_FALLBACK : m);
    }
  }

  /** Picker fallback for when the label match got the wrong device (or the
   *  streamer wants a different one). Only offered between jobs. */
  function switchCamera(id: string) {
    setCamId(id);
    void arm(id === "auto" ? undefined : id);
  }

  async function panic() {
    try {
      const { paused } = await api.panic();
      setPausedByMe(paused);
      pushLog(paused ? "PANIC — paused" : "resumed");
      flash(paused ? "Stopped. New hijacks are paused." : "Hijacks are back on.");
    } catch {
      flash(`Couldn't stop it. Press ${PANIC_KEY}, or close the app.`, "bad");
    }
  }

  /** Autosave a settings change (studio and dashboard behave the same). */
  async function saveSettings(patch: Partial<Settings>) {
    if (settings) setSettings({ ...settings, ...patch }); // optimistic
    try {
      const next = await api.saveSettings(patch);
      setSettings(next);
      if (next.outputGuard !== "off") void guardRef.current?.ready();
      flash("Saved");
    } catch {
      flash("Couldn't save that. Try again.", "bad");
      api.getSettings().then(setSettings).catch(() => {});
    }
  }

  /** Run an effect on the streamer's own camera: the hosted channel's free
   *  daily preview in cloud mode, the local console path otherwise. */
  async function tryEffect(p: Preset) {
    setPicking(false);
    setTab("live");
    try {
      const r = cfg?.cloud ? await api.testHijack(p.id) : await api.manualHijack(p.prompt, PREVIEW_SEC);
      // `outcome` is engine text ("dropped: queue full"…): never shown raw.
      const started = r.ok && !/^(dropped|ignored)/i.test(r.outcome);
      flash(started ? `Starting ${p.label}…` : friendlyStreamerError(r.outcome), started ? "ok" : "bad");
    } catch (e) {
      flash(friendlyStreamerError(e), "bad");
    }
  }

  // Hosted only: is this streamer cleared to take payments? Re-read whenever
  // they land on Live, so finishing Stripe setup clears the banner.
  const hosted = Boolean(cfg?.cloud);
  useEffect(() => {
    if (!hosted || tab !== "live") return;
    api.payouts().then(setPayouts).catch(() => {});
  }, [hosted, tab]);
  const payoutsNotReady = hosted && payouts !== null && payouts.configured && !payouts.enabled;

  const paused = pausedByMe ?? status?.paused ?? false;
  const busy = state !== "IDLE" && state !== "OFFLINE";
  const chip = statusOf(state, armed, paused, remaining);
  const canTry = armed && !busy && !paused;
  const tryNote = !armed ? "Turn on Stream Hijack first" : paused ? "Resume hijacks first" : "Wait for the current effect";
  const signedInHere = Boolean(cfg?.cloud && desktopBridge());
  const jobPreset = job?.presetId ? PRESETS_BY_ID[job.presetId] : undefined;
  const pending = status?.reviewPending ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-6 pb-16">
      {touring && (
        <FirstRunTour
          onDone={(goTo) => {
            setTouring(false);
            setTab(goTo);
          }}
        />
      )}

      {/* ── Top bar: status, tabs, the stop switch ─────────────────── */}
      <div className="sticky top-0 z-30 -mx-6 mb-6 border-b border-white/10 bg-[#121112]/90 px-6 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          <StatusChip {...chip} />
          <nav aria-label="Studio" className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={`relative min-h-11 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors ${
                  tab === t.id ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {t.label}
                {t.id === "live" && pending > 0 && (
                  <span
                    aria-label={`${pending} waiting for your OK`}
                    className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-xs text-black"
                  >
                    {pending}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <button className={btn.ghost} onClick={() => setTouring(true)}>
              How it works
            </button>
            {signedInHere && (
              <button className={btn.ghost} onClick={() => setSigningOut(true)}>
                Sign out
              </button>
            )}
            {/* Esc works while this window is focused; the panic key works from any app. */}
            {paused ? (
              <button onClick={() => void panic()} className={btn.secondary} title="Esc in this window">
                Resume hijacks
              </button>
            ) : busy ? (
              <button onClick={() => void panic()} className={btn.danger} title={`Esc in this window, or ${PANIC_KEY} from any app`}>
                Stop effect <kbd className="rounded bg-black/25 px-1.5 text-xs font-normal">Esc</kbd>
              </button>
            ) : (
              <button onClick={() => void panic()} className={btn.secondary} title={`Esc in this window, or ${PANIC_KEY} from any app`}>
                Pause hijacks <kbd className="rounded bg-black/25 px-1.5 text-xs font-normal">Esc</kbd>
              </button>
            )}
          </div>
        </div>
      </div>

      {signingOut && (
        <ConfirmDialog
          title="Sign out of Stream Hijack?"
          body="Chat won't be able to pay until you sign in again."
          confirmLabel="Sign out"
          cancelLabel="Stay"
          onCancel={() => setSigningOut(false)}
          onConfirm={() => {
            setSigningOut(false);
            void desktopBridge()?.signOut();
          }}
        />
      )}

      {toast && (
        <div
          role={toast.tone === "bad" ? "alert" : "status"}
          className={`fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-xl ${
            toast.tone === "ok" ? "bg-zinc-100 text-zinc-900" : "bg-red-600 text-white"
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* ── Live ──────────────────────────────────────────────────────
          Always mounted: the machine attaches the AI stream to these video
          elements once per job, whatever tab is showing. */}
      <div className={tab === "live" ? "space-y-6" : "hidden"}>
        {payoutsNotReady && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-950/30 p-4">
            <p className="text-amber-200">Chat can't pay yet. Set up payouts to start earning.</p>
            <button className={btn.secondary} onClick={() => setTab("earnings")}>
              Set up payouts
            </button>
          </div>
        )}

        {cfg?.cloud && <ShareBar url={cfg.cloud.portalUrl} primary={armed} />}

        <ReviewPanel client={api} pending={status?.reviewPending} />

        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black">
          <video ref={aiPreviewRef} muted playsInline className="aspect-video w-full object-contain" />
          {/* Camera inset: "am I on?" at a glance. */}
          <div className={`absolute bottom-4 right-4 w-52 overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl ${armed ? "" : "hidden"}`}>
            <video ref={previewRef} muted playsInline className="aspect-video w-full object-cover" />
            <p className="absolute left-2 top-1.5 rounded bg-black/50 px-1.5 text-xs text-zinc-200">Your camera</p>
          </div>

          {!armed ? (
            <div className="absolute inset-0 grid place-items-center bg-gradient-to-b from-zinc-950/60 to-zinc-950/90 p-6 text-center">
              <div className="max-w-md">
                <h1 className="text-3xl font-bold tracking-tight text-zinc-50">Ready when you are.</h1>
                <p className="mt-2 text-zinc-300">
                  Turn it on when you go live. Chat's effects will play over your OBS Virtual Camera.
                </p>
                <button onClick={() => void arm()} className={btn.primary + " mt-6 px-7 py-3 text-lg"}>
                  Turn on Stream Hijack
                </button>
                {armError && (
                  <p role="alert" className="mt-4 text-sm text-red-300">
                    {armError}
                  </p>
                )}
              </div>
            </div>
          ) : (
            !busy && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
                <p className="text-zinc-500">
                  {paused ? "Paused. Chat can't start a hijack." : "When someone in chat pays, their effect plays here and on stream."}
                </p>
              </div>
            )
          )}

          {job && busy && (
            <div className="absolute left-4 top-4 flex items-center gap-3 rounded-2xl bg-black/60 p-2 pr-4 backdrop-blur">
              {jobPreset ? (
                <EffectArt preset={jobPreset} size="sm" className="w-20 rounded-xl" />
              ) : (
                <span className="grid h-11 w-20 place-items-center rounded-xl bg-zinc-800 px-1 text-center text-xs font-semibold leading-tight text-zinc-200">
                  Custom effect
                </span>
              )}
              <div className="text-sm">
                <p className="font-semibold text-white">{jobPreset?.label ?? "Custom effect"}</p>
                <p className="tabular-nums text-zinc-300">
                  {job.tip.username || "Someone in chat"} · {state === "LIVE" && remaining != null ? `${remaining}s left` : "Starting…"}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Readiness
            label="Camera"
            ok={armed}
            detail={armed ? (camLabel ?? "On") : "Off. Turn on Stream Hijack above."}
          >
            {armed && cams.length > 0 && !busy && (
              <select
                aria-label="Camera"
                value={camId}
                onChange={(e) => switchCamera(e.target.value)}
                className="mt-2 min-h-11 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 text-sm"
              >
                <option value="auto">Auto (OBS Virtual Camera)</option>
                {cams.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </Readiness>
          <ObsReadiness cfg={cfg} />
          <Readiness
            label="Up next"
            ok
            neutral
            detail={status?.queueLength ? `${status.queueLength} in line` : "Nobody waiting"}
          >
            <button
              className={btn.secondary + " mt-2 w-full"}
              disabled={!canTry}
              title={canTry ? undefined : tryNote}
              onClick={() => setPicking(true)}
            >
              Try an effect on me
            </button>
          </Readiness>
        </div>
        {settings && settings.outputGuard !== "off" && (
          <p className="text-sm text-zinc-400">
            {guardReady ? "Live safety check ready" : "Live safety check loading…"}
          </p>
        )}
      </div>

      {tab === "effects" && (
        <EffectsTab
          settings={settings}
          settingsError={settingsError}
          onRetry={() => loadSettings()}
          onChange={(p) => void saveSettings(p)}
          onTry={(p) => void tryEffect(p)}
          canTry={canTry}
          tryNote={tryNote}
        />
      )}

      {tab === "safety" && (
        <div className="space-y-6">
          <header>
            <h1 className="text-2xl font-bold text-zinc-50">Rules</h1>
            <p className="mt-1 text-zinc-400">What chat may do on your stream. Changes save instantly.</p>
          </header>
          {settings ? (
            <SafetyEditor settings={settings} onChange={(p) => void saveSettings(p)} local={!cfg?.cloud} />
          ) : settingsError ? (
            <ErrorCard message={settingsError} onRetry={() => loadSettings()} />
          ) : (
            <p className="text-zinc-400">Loading your rules…</p>
          )}
          <ModerationPanel
            client={api}
            settings={settings}
            onBan={(name) => settings && void saveSettings({ bannedViewers: [...settings.bannedViewers, name] })}
            onUnban={(name) => settings && void saveSettings({ bannedViewers: settings.bannedViewers.filter((x) => x !== name) })}
          />
        </div>
      )}

      {tab === "earnings" && <EarningsTab cloud={cfg?.cloud ?? null} />}

      {picking && (
        <EffectPicker
          settings={settings}
          cloud={Boolean(cfg?.cloud)}
          onPick={(p) => void tryEffect(p)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/** `primary` only once the camera is on — until then "Turn on Stream Hijack" is the one filled button. */
function ShareBar({ url, primary }: { url: string; primary: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-r from-brand-900/40 to-zinc-950 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-300">Your hijack link — share it in chat, your panels, or a !hijack command</p>
        <p className="truncate font-mono text-lg text-white">{url.replace(/^https?:\/\//, "")}</p>
      </div>
      <button
        className={primary ? btn.primary : btn.secondary}
        onClick={() =>
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        {copied ? "Copied ✓" : "Copy link"}
      </button>
      <button className={btn.secondary} onClick={() => void desktopBridge()?.openExternal(url)}>
        Open ↗
      </button>
    </div>
  );
}

function Readiness({
  label,
  ok,
  neutral,
  detail,
  children,
}: {
  label: string;
  ok: boolean;
  neutral?: boolean;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <Card className="!p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
        {!neutral && (
          <span aria-hidden className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400"}`} />
        )}
        {label}
      </p>
      <p className="mt-1 text-sm text-zinc-400">{detail}</p>
      {children}
    </Card>
  );
}

/** OBS in plain words: connected? where's the overlay? and a fix-it button. */
function ObsReadiness({ cfg }: { cfg: RouterConfig | null }) {
  const desktop = desktopBridge();
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const connected = cfg?.obsConnected ?? false;
  const overlay = cfg?.obsOverlay;
  const where = overlay?.length
    ? overlay.map((p) => (p.camera ? `“${p.scene}” over “${p.camera}”` : `“${p.scene}”`)).join(", ")
    : null;
  const detail = !cfg
    ? "Checking OBS…"
    : !connected
      ? "OBS isn't open. Open it and we'll connect."
      : where
        ? `Connected · overlay in ${where}`
        : "Connected · overlay not added yet";

  async function repair() {
    if (!desktop) return;
    setWorking(true);
    try {
      const r = await desktop.provisionObs();
      setNote(r.ok ? r.detail : `Couldn't add the overlay. ${friendlyStreamerError(r.detail)}`);
    } catch (e) {
      setNote(`Couldn't add the overlay. ${friendlyStreamerError(e)}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <Readiness label="OBS" ok={connected} detail={detail}>
      {desktop && (
        <div className="mt-2 flex gap-2">
          {connected ? (
            <button className={btn.secondary} disabled={working} onClick={() => void repair()}>
              {working ? "Adding the overlay…" : "Add the overlay again"}
            </button>
          ) : (
            <button className={btn.secondary} onClick={() => void desktop.launchObs().catch(() => {})}>
              Open OBS
            </button>
          )}
        </div>
      )}
      {note && <p className="mt-2 text-sm text-zinc-400">{note}</p>}
    </Readiness>
  );
}

/** Pick an effect to preview on the streamer's own camera. */
function EffectPicker({
  settings,
  cloud,
  onPick,
  onClose,
}: {
  settings: Settings | null;
  cloud: boolean;
  onPick: (p: Preset) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const list = PRESETS.filter((p) => !p.needsImage && (!settings || presetAllowed(p, settings)));
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="picker-title" className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-white/10 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="picker-title" className="text-xl font-bold text-zinc-50">Try an effect on yourself</h2>
            <p className="mt-1 text-sm text-zinc-400">
              {cloud
                ? `Plays for ${PREVIEW_SEC} seconds on your stream. Free, once a day.`
                : `Plays for ${PREVIEW_SEC} seconds on your stream.`}
            </p>
          </div>
          <button className={btn.ghost + " min-w-11 justify-center"} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.map((p) => (
            <li key={p.id} className="relative" {...previewHandlers(p.id)}>
              <button
                onClick={() => onPick(p)}
                className="w-full overflow-hidden rounded-2xl border border-white/10 text-left hover:border-brand-500"
              >
                <EffectArt preset={p} size="sm" />
                <span className="block px-3 py-2 text-sm font-semibold text-zinc-100">{p.label}</span>
              </button>
              {/* Sibling of the card button (a button in a button is invalid HTML). */}
              <PreviewPlayButton id={p.id} label={p.label} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
