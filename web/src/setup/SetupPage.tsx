// The onboarding wizard — the "≤5 minutes to live" flow (plan M4; brief
// docs/product/briefs/001-setup-ux.md). Renders only inside the Electron
// shell (window.rhDesktop). Seven steps, each skippable where the plan
// allows; every step reads real state from the main process and deep-links
// back when something fails. "Stream safety" is the one step that can't be
// skipped: it's where the streamer acknowledges the platform obligations the
// product can't carry for them (CONTENT-SAFETY S6).
//
// Order matters: OBS comes BEFORE the camera, because the camera we want is
// OBS's Virtual Camera and the app can start it over obs-websocket. The test
// step is itself a router (useRouterEngine) — the window is still on /setup
// at that point, and a job dispatched to no router is a job nobody sees.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, DesktopSetupState, RouterState } from "@rh/shared";
import { desktopBridge } from "../lib/desktop.js";
import { PANIC_KEY, TRAY_NAME } from "../lib/platform.js";
import { acquireCamera, listCameras } from "../router/decartSession.js";
import { StreamVideo, useRouterEngine } from "../router/useRouterEngine.js";
import { Keycap } from "../features/Keycap.js";
import { PAYOUT_COUNTRIES } from "../dashboard/PayoutsPanel.js";

// The wizard reads everything through the typed preload bridge
// (shared/src/desktopBridge.ts) — no hand-declared window shape here.
type SetupState = DesktopSetupState;
type RhDesktopSetup = DesktopBridge;

const desktop = desktopBridge;

const STEPS = [
  "Sign in",
  "Connect OBS",
  "Camera",
  "Get paid",
  "Stream safety",
  "Test hijack",
  "Done",
] as const;

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export default function SetupPage() {
  const d = desktop();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<SetupState | null>(null);
  // The device the streamer settled on in the camera step; the test step
  // arms the same one so what they previewed is what gets restyled.
  const [cameraId, setCameraId] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    void d?.setupState().then(setState);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!d) {
    return (
      <div className="grid h-screen place-items-center text-zinc-500">
        The setup wizard runs inside the Reality Hijack app.
      </div>
    );
  }
  if (!state) {
    return (
      <div className="grid h-screen place-items-center text-zinc-500">
        Loading…
      </div>
    );
  }

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  return (
    <div className="mx-auto max-w-2xl p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">Set up Reality Hijack</h1>
        <Stepper step={step} />
      </header>

      {step === 0 && <SignInStep d={d} state={state} next={next} />}
      {step === 1 && (
        <ObsStep d={d} state={state} refresh={refresh} next={next} />
      )}
      {step === 2 && (
        <CameraStep d={d} state={state} refresh={refresh} next={next} onChosen={setCameraId} />
      )}
      {step === 3 && <PayoutsStep d={d} state={state} next={next} />}
      {step === 4 && <SafetyStep state={state} next={next} />}
      {step === 5 && <TestStep d={d} state={state} cameraId={cameraId} next={next} />}
      {step === 6 && <DoneStep d={d} state={state} />}

      {step > 0 && step < STEPS.length - 1 && (
        <button
          onClick={() => setStep((s) => s - 1)}
          className="mt-6 text-sm text-zinc-500 underline"
        >
          ← Back
        </button>
      )}
    </div>
  );
}

/** One line, always: "Step n of 7 · Name" plus a segment per step. Nothing
 *  here changes width when a step completes — the old chip strip wrapped to
 *  two lines and reflowed every time a "✓ " was prepended. */
function Stepper({ step }: { step: number }) {
  return (
    <div className="mt-4 flex items-center gap-3 whitespace-nowrap text-sm">
      <span className="font-mono text-xs text-zinc-500">
        Step {step + 1} of {STEPS.length}
      </span>
      <span className="font-semibold text-zinc-100">{STEPS[step]}</span>
      <ol className="ml-2 flex min-w-0 flex-1 gap-1" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            title={label}
            className={`h-1.5 flex-1 rounded-full ${
              i < step ? "bg-emerald-600" : i === step ? "bg-brand-600" : "bg-zinc-800"
            }`}
          />
        ))}
      </ol>
      {step + 1 < STEPS.length && (
        <span className="hidden text-xs text-zinc-500 sm:inline">Next: {STEPS[step + 1]}</span>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
      {children}
    </div>
  );
}

function Primary(props: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className="rounded-lg bg-brand-600 px-5 py-2 font-semibold hover:bg-brand-700 disabled:opacity-40"
    >
      {props.children}
    </button>
  );
}

function Secondary(props: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
    >
      {props.children}
    </button>
  );
}

function Skip({ next, label }: { next: () => void; label?: string }) {
  return (
    <button onClick={next} className="text-sm text-zinc-500 underline">
      {label ?? "Skip for now"}
    </button>
  );
}

/** A compact fact row: "OBS · connected" — single line, fixed shape. */
function Chip({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "off" }) {
  const color =
    tone === "ok" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : "text-zinc-500";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </span>
  );
}

/** An error thrown in the main process, minus Electron's IPC wrapper
 *  ("Error invoking remote method 'rh:…': Error: "). */
function ipcMessage(e: unknown): string {
  return (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// ── Step 1: Sign in ───────────────────────────────────────────────────────

function SignInStep({
  d,
  state,
  next,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  next: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [decartKey, setDecartKey] = useState("");
  const [saved, setSaved] = useState(false);
  if (state.cloudMode) {
    return (
      <Card>
        <p>
          Signed in as <b className="text-brand-400">{state.login}</b>. Your viewer page,
          payments and the AI model run on the Reality Hijack service — no API keys on this
          machine.
        </p>
        <Primary onClick={next}>Continue</Primary>
      </Card>
    );
  }
  // Pasted-keys local mode: a dev fallback only (repo runs, RH_LOCAL_MODE=1).
  // Streamers never see a key field — the hosted control plane holds the
  // Decart key for them.
  const localMode = state.localModeAllowed && (
    <details className="text-sm text-zinc-500">
      <summary className="cursor-pointer">Developer: run with my own keys instead</summary>
      <div className="mt-3 space-y-3">
        {state.keys.decartApiKey || saved ? (
          <p className="text-emerald-400">✓ Decart key saved — it loads when setup finishes.</p>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              value={decartKey}
              onChange={(e) => setDecartKey(e.target.value)}
              placeholder="Decart API key"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            />
            <button
              disabled={!decartKey.trim()}
              onClick={() =>
                void d.saveKeys({ decartApiKey: decartKey.trim() }).then(() => setSaved(true))
              }
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        )}
        <Skip next={next} label="Continue in local mode" />
      </div>
    </details>
  );

  // This build has no control plane baked in (nothing deployed yet): say so.
  // The app still runs end to end in passthrough demo mode, so the rest of
  // setup — OBS, camera, the safety acknowledgement — is still worth doing.
  if (!state.cloudUrl) {
    return (
      <Card>
        <p className="text-zinc-300">
          <b>Hosted sign-in isn't available in this build yet.</b> Reality Hijack signs you in
          with Twitch and runs payments, moderation and the AI model from our servers —
          nothing to configure on your side. That service isn't live for this build; you can
          still set up OBS and your camera and try the flow with a passthrough test effect.
        </p>
        <Primary onClick={next}>Continue</Primary>
        {localMode}
      </Card>
    );
  }
  return (
    <Card>
      <p className="text-zinc-300">
        Sign in with Twitch to get your viewer page and payments — no config files, no API
        keys. Your browser opens; the app picks the session up on its own and restarts once,
        signed in.
      </p>
      <div className="flex items-center gap-4">
        <Primary
          disabled={waiting}
          onClick={() => {
            setWaiting(true);
            void d.signIn().finally(() => setWaiting(false));
          }}
        >
          {waiting ? "Waiting for your browser…" : "Sign in with Twitch"}
        </Primary>
      </div>
      {localMode}
    </Card>
  );
}

// ── Step 2: Connect OBS ───────────────────────────────────────────────────

function ObsStep({
  d,
  state,
  refresh,
  next,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  refresh: () => void;
  next: () => void;
}) {
  const [result, setResult] = useState<string | null>(null);
  const [overlayOk, setOverlayOk] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const disc = state.obs.discovery;
  const obsRunning = state.obs.running;

  return (
    <Card>
      <p className="text-sm text-zinc-400">
        Reality Hijack talks to OBS to show and hide the effect. Nothing else in your scenes
        changes.
      </p>
      <div className="flex flex-wrap gap-2">
        <Chip
          label="OBS"
          value={
            disc === "not-installed"
              ? "not found"
              : state.obs.connected
                ? "connected"
                : obsRunning
                  ? "running, not connected"
                  : "not running"
          }
          tone={state.obs.connected ? "ok" : disc === "not-installed" ? "warn" : "off"}
        />
        <Chip
          label="Overlay source"
          value={overlayOk ? "ready" : "not yet"}
          tone={overlayOk ? "ok" : "off"}
        />
      </div>

      {disc === "not-installed" && (
        <>
          <p className="text-zinc-300">
            OBS Studio doesn't seem to be installed (or has never been opened). Install OBS
            30 or newer, open it once, then come back here. Or add the overlay by hand
            later: a Browser Source pointing at
          </p>
          <code className="block break-all rounded bg-zinc-900 p-2 text-xs">
            {state.viewerUrl}
          </code>
        </>
      )}
      {disc === "disabled" && (
        <>
          <p className="text-zinc-300">
            OBS is installed but its <b>WebSocket server is off</b> — that's the door the app
            uses. We can switch it on for you; OBS only reads the setting when it starts, so
            it has to be closed first.
          </p>
          {obsRunning ? (
            <p className="text-sm text-amber-400">
              OBS is running — quit it, and this button unlocks on its own.
            </p>
          ) : (
            <p className="text-sm text-zinc-500">
              Or do it by hand in OBS: Tools → WebSocket Server Settings → Enable.
            </p>
          )}
          <Primary
            disabled={obsRunning || enabling}
            onClick={() => {
              setEnabling(true);
              setResult(null);
              void d
                .enableObsWebsocket()
                .then((r) => {
                  if (r === "obs-running") setResult("OBS is still running — quit it and try again.");
                  else if (r === "no-config") setResult("OBS has never been started on this computer — open it once, quit, and try again.");
                  else setResult("Switched on. Starting OBS — this page connects on its own.");
                  refresh();
                })
                .catch((e) => setResult(`Couldn't switch it on: ${ipcMessage(e)}`))
                .finally(() => setEnabling(false));
            }}
          >
            {enabling ? "Switching on…" : "Switch it on for me and start OBS"}
          </Primary>
          {result && <p className="text-sm text-zinc-300">{result}</p>}
        </>
      )}
      {(disc === "found" || disc === "unreadable") && !state.obs.connected && (
        <>
          <p className="text-zinc-300">
            {obsRunning
              ? "OBS is running; the app is connecting to it. If this takes more than a few seconds, check Tools → WebSocket Server Settings in OBS."
              : "OBS is installed but not running. Start it and the app connects on its own."}
          </p>
          {!obsRunning && (
            <Primary
              onClick={() =>
                void d
                  .launchObs()
                  .then(refresh)
                  .catch((e) => setResult(`Couldn't start OBS: ${ipcMessage(e)}`))
              }
            >
              Start OBS
            </Primary>
          )}
          {result && <p className="text-sm text-red-400">{result}</p>}
        </>
      )}
      {state.obs.connected && (
        <>
          <p className="text-emerald-400">✓ Connected to OBS.</p>
          <p className="text-zinc-300">
            One click adds a hidden <b>AI Hijack</b> source to your current scene (or repairs
            it if it drifted). It stays invisible until a hijack is actually playing.
          </p>
          <Primary
            onClick={() =>
              void d
                .provisionObs()
                .then((r) => {
                  setOverlayOk(r.ok);
                  setResult(r.ok ? `✓ ${r.detail}` : r.detail);
                  refresh();
                })
                .catch((e) => setResult(`Couldn't add the source: ${(e as Error).message}`))
            }
          >
            {overlayOk ? "Add it again" : "Add the AI Hijack source"}
          </Primary>
          {result && <p className="text-sm text-emerald-400">{result}</p>}
        </>
      )}
      <div className="flex items-center gap-4">
        {(overlayOk || result) && <Primary onClick={next}>Continue</Primary>}
        <Skip next={next} label="Skip — I'll add the Browser Source myself" />
      </div>
    </Card>
  );
}

// ── Step 3: Camera ────────────────────────────────────────────────────────

function CameraStep({
  d,
  state,
  refresh,
  next,
  onChosen,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  refresh: () => void;
  next: () => void;
  onChosen: (deviceId: string | undefined) => void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [label, setLabel] = useState<string>("");
  const [usingObs, setUsingObs] = useState(false);
  const [cams, setCams] = useState<{ deviceId: string; label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const obsConnected = state.obs.connected;
  const vcam = state.obs.virtualCamActive; // true | false | null (unknown)

  async function grab(deviceId?: string) {
    setError(null);
    try {
      const got = await acquireCamera(deviceId);
      stream?.getTracks().forEach((t) => t.stop());
      setStream(got.stream);
      setUsingObs(got.usingObs);
      setLabel(got.usingObs ? "OBS Virtual Camera" : (got.stream.getVideoTracks()[0]?.label ?? "camera"));
      onChosen(deviceId);
      setCams(await listCameras());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startVirtualCam() {
    setStarting(true);
    setNote(null);
    try {
      const r = await d.startVirtualCamera();
      if (r === "obs-not-connected") {
        setNote("OBS isn't connected — go back one step.");
        return;
      }
      setNote(r === "started" ? "Virtual Camera started." : "The Virtual Camera was already on.");
      refresh();
      // The device takes a moment to appear to the OS after OBS starts it.
      await new Promise((res) => setTimeout(res, 1200));
      await grab();
    } catch (e) {
      setNote(`Couldn't start it: ${ipcMessage(e)}`);
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [stream]);

  return (
    <Card>
      <p className="text-zinc-300">
        Reality Hijack takes your picture from <b>OBS's Virtual Camera</b>, not straight from
        the webcam, so the effect lands on exactly what you show on stream — your scene,
        framing and filters.
      </p>
      <div className="flex flex-wrap gap-2">
        <Chip label="OBS" value={obsConnected ? "connected" : "not connected"} tone={obsConnected ? "ok" : "warn"} />
        <Chip
          label="Virtual Camera"
          value={vcam === true ? "on" : vcam === false ? "off" : "unknown"}
          tone={vcam === true ? "ok" : vcam === false ? "warn" : "off"}
        />
        {stream && <Chip label="Capturing" value={label} tone={usingObs ? "ok" : "warn"} />}
      </div>

      {!stream && !obsConnected && (
        <p className="text-sm text-amber-400">
          OBS isn't connected. You can pick a camera anyway, but effects will restyle the raw
          webcam, not your OBS scene. Use ← Back to connect OBS first.
        </p>
      )}
      {!stream && obsConnected && vcam === false && (
        <>
          <p className="text-sm text-amber-400">
            OBS's Virtual Camera is off. Start it from here, or in OBS under Controls → Start
            Virtual Camera.
          </p>
          <p className="text-sm text-zinc-500">
            In OBS, set the Virtual Camera's output type to <b>Source</b> (the gear next to
            Start Virtual Camera), not Program — otherwise the AI effect feeds back into
            itself.
          </p>
        </>
      )}
      {!stream && obsConnected && vcam !== false && (
        <p className="text-sm text-zinc-500">
          {IS_MAC ? "macOS" : "Windows"} asks for camera permission once. The preview that
          appears is the Virtual Camera's picture — the same thing your viewers see.
        </p>
      )}

      {stream && (
        <StreamVideo
          stream={stream}
          className="aspect-video w-full rounded-xl border border-zinc-800 bg-black object-cover"
        />
      )}
      {stream && usingObs && (
        <p className="text-sm text-emerald-400">
          ✓ This is your OBS Virtual Camera — what effects will restyle.
        </p>
      )}
      {stream && !usingObs && (
        <>
          <p className="text-sm text-amber-400">
            This is <b>{label}</b>, not the OBS Virtual Camera. If OBS's Virtual Camera is
            running, pick it below.
          </p>
          {cams.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Camera
              <select
                onChange={(e) => void grab(e.target.value || undefined)}
                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm"
                defaultValue=""
              >
                <option value="">Pick a camera…</option>
                {cams.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {error && <p className="text-sm text-red-400">Camera failed: {error}</p>}
      {note && <p className="text-sm text-zinc-300">{note}</p>}

      <div className="flex flex-wrap items-center gap-4">
        {!stream && obsConnected && vcam === false && (
          <Primary disabled={starting} onClick={() => void startVirtualCam()}>
            {starting ? "Starting…" : "Start the Virtual Camera"}
          </Primary>
        )}
        {!stream && !(obsConnected && vcam === false) && (
          <Primary onClick={() => void grab()}>
            {obsConnected ? "Use the OBS Virtual Camera" : "Pick a camera anyway"}
          </Primary>
        )}
        {!stream && obsConnected && vcam === false && (
          <Secondary onClick={() => void grab()}>I started it myself — continue</Secondary>
        )}
        {stream && (
          <Primary onClick={next}>{usingObs ? "Looks good — continue" : "Use it anyway — continue"}</Primary>
        )}
      </div>
    </Card>
  );
}

// ── Step 4: Get paid ──────────────────────────────────────────────────────

type Payouts = { configured: boolean; started: boolean; enabled: boolean } | null;

function PayoutsStep({
  d,
  state,
  next,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  next: () => void;
}) {
  const [info, setInfo] = useState<Payouts | "loading">("loading");
  const [country, setCountry] = useState("US");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll: the streamer finishes Stripe in the browser and comes back here;
  // the step flips to "ready" without a click.
  useEffect(() => {
    if (!state.cloudMode) return;
    let alive = true;
    const tick = () =>
      d.payouts().then((p) => alive && setInfo(p)).catch((e) => alive && setError(ipcMessage(e)));
    void tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [d, state.cloudMode]);

  if (!state.cloudMode) {
    return (
      <Card>
        <p className="text-zinc-300">
          Local mode has no payments. Run effects on yourself from the studio's
          <b> Try an effect</b> panel; nothing here bills anyone.
        </p>
        <Primary onClick={next}>Continue</Primary>
      </Card>
    );
  }

  const ready = info !== "loading" && info?.enabled;
  const started = info !== "loading" && info?.started && !info.enabled;

  return (
    <Card>
      <p className="text-zinc-300">
        Viewers pay by card on your page — <b>$1 buys 1 second</b> of hijack. Stripe sends
        your share to your bank and keeps our cut (the GPU time plus 5%). You need a Stripe
        account once; Stripe handles identity and bank details, we never see them.
      </p>
      <div className="flex flex-wrap gap-2">
        <Chip
          label="Payouts"
          value={
            info === "loading"
              ? "checking…"
              : !info || !info.configured
                ? "not available on this server"
                : info.enabled
                  ? "ready"
                  : info.started
                    ? "Stripe is verifying"
                    : "not set up"
          }
          tone={ready ? "ok" : started ? "warn" : "off"}
        />
      </div>

      {info !== "loading" && (!info || !info.configured) && (
        <p className="text-sm text-zinc-500">
          Payments aren't switched on for this server (dev mode). Skip this step.
        </p>
      )}
      {ready && (
        <p className="text-sm text-emerald-400">✓ Payouts ready — viewers can pay on your page.</p>
      )}
      {started && (
        <p className="text-sm text-amber-300">
          Stripe is still verifying your details. Carry on with setup — this flips to ready on
          its own, and you can finish anything Stripe still needs from the dashboard.
        </p>
      )}
      {info !== "loading" && info?.configured && !info.enabled && (
        <div className="flex flex-wrap items-center gap-3">
          {!info.started && (
            <label className="flex items-center gap-2 text-sm text-zinc-400">
              Country
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm"
              >
                {PAYOUT_COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Primary
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void d
                .startPayouts(country)
                .catch((e) => setError(ipcMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Opening Stripe…" : info.started ? "Continue Stripe setup" : "Set up payouts with Stripe"}
          </Primary>
          <span className="text-xs text-zinc-500">Opens in your browser; come back here after.</span>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <p className="text-xs text-zinc-500">
        Until payouts are ready, your page can't take payments. Test hijacks still work.
      </p>
      <div className="flex items-center gap-4">
        <Primary onClick={next}>Continue</Primary>
        {!ready && <Skip next={next} label="Later, from the dashboard" />}
      </div>
    </Card>
  );
}

// ── Step 5: Stream safety ─────────────────────────────────────────────────

/** What each platform asks of the streamer when viewers can restyle their
 *  stream with AI (docs/CONTENT-SAFETY.md §1). Plain-language, and every box
 *  must be ticked — this is the step that can't be skipped. */
const SAFETY_CHECKS: { id: string; text: React.ReactNode }[] = [
  {
    id: "own-content",
    text: "Whatever the AI shows on my stream counts as my content under Twitch, YouTube and Kick rules — nudity or sexual content can get my channel banned even if a viewer asked for it.",
  },
  {
    id: "panic",
    text: (
      <>
        If anything looks wrong I'll press <Keycap>{PANIC_KEY}</Keycap> — it works from any
        app, even with OBS focused — or use the {TRAY_NAME}. The effect disappears from my
        stream at once and new hijacks wait until I resume.
      </>
    ),
  },
  {
    id: "disclosure",
    text: "I'll disclose AI effects where my platform asks: Kick needs it in my title or on screen (the \"AI-altered\" label covers this), and YouTube asks me to tick its altered-content box for realistic changes.",
  },
  {
    id: "likeness",
    text: "Face swaps only use photos viewers have consent for, and never of anyone under 18 or of real public figures. I can require my own approval for every swap.",
  },
];

function SafetyStep({ state, next }: { state: SetupState; next: () => void }) {
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const all = SAFETY_CHECKS.every((c) => ticked[c.id]);
  return (
    <Card>
      <p className="text-zinc-300">
        Viewers always write their own prompt and can add a photo. Every word and image is
        checked by AI moderators before it reaches the model — and before the viewer can pay.
        The presets on your page are examples of what works well, not the only options. A few
        things are still on you:
      </p>
      <div className="space-y-2">
        {SAFETY_CHECKS.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-start gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={Boolean(ticked[c.id])}
              onChange={(e) => setTicked({ ...ticked, [c.id]: e.target.checked })}
              className="mt-1"
            />
            <span>{c.text}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-zinc-500">
        {state.cloudMode
          ? "You can tighten this anytime from your dashboard: require your approval for each effect, limit photos to scenes, or switch custom prompts off."
          : "In local mode you supply the moderation keys (studio → Advanced → credentials). Without them, custom prompts and photos stay off."}
      </p>
      <div className="flex items-center gap-4">
        <Primary onClick={next} disabled={!all}>
          I understand — continue
        </Primary>
      </div>
    </Card>
  );
}

// ── Step 6: Test hijack ───────────────────────────────────────────────────

const TEST_PROMPT = "Retro 1980s anime cel-shaded style, bold ink outlines, neon sunset gradients";
const TEST_SEC = 10;

const PHASE_LABEL: Record<RouterState, string> = {
  OFFLINE: "camera off",
  IDLE: "ready",
  AUTHORIZING: "starting",
  CONNECTING: "connecting to the model",
  BUFFERING: "warming up — a few seconds",
  LIVE: "LIVE",
  TEARDOWN: "reverting",
};

/** The wizard IS the router here (useRouterEngine): it arms the camera the
 *  streamer picked, fires the free test, shows the model's output inline,
 *  and then asks the only question that matters — did you see it? */
function TestStep({
  d,
  state,
  cameraId,
  next,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  cameraId: string | undefined;
  next: () => void;
}) {
  const r = useRouterEngine();
  const [phase, setPhase] = useState<"idle" | "firing" | "running" | "ended">("idle");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sawLive, setSawLive] = useState(false);
  const [verdict, setVerdict] = useState<"yes" | "no" | null>(null);
  const [overlayNote, setOverlayNote] = useState<string | null>(null);
  const armedOnce = useRef(false);

  useEffect(() => {
    if (armedOnce.current) return;
    armedOnce.current = true;
    void r.arm(cameraId);
  }, [r, cameraId]);

  // Phase tracking off the real machine state: firing → (any non-idle
  // state) running → back to IDLE ended. "Saw live" is the truth we compare
  // the streamer's answer against.
  useEffect(() => {
    if (r.state === "LIVE") setSawLive(true);
    if (phase === "firing" && r.state !== "IDLE" && r.state !== "OFFLINE") setPhase("running");
    if (phase === "running" && r.state === "IDLE") setPhase("ended");
  }, [r.state, phase]);

  // A dispatched job that never reaches the router (paused engine, queue
  // full) would leave "firing" forever; give it a bounded wait.
  useEffect(() => {
    if (phase !== "firing") return;
    const t = setTimeout(() => setPhase((p) => (p === "firing" ? "ended" : p)), 12_000);
    return () => clearTimeout(t);
  }, [phase]);

  const armed = r.cameraStream !== null && r.state !== "OFFLINE";
  const model = state.decartEnabled;

  function fire() {
    setError(null);
    setOutcome(null);
    setSawLive(false);
    setVerdict(null);
    setPhase("firing");
    d.testHijack(TEST_PROMPT, TEST_SEC)
      .then(setOutcome)
      .catch((e) => {
        setError(ipcMessage(e));
        setPhase("idle");
      });
  }

  const obsConnected = r.cfg?.obsConnected ?? state.obs.connected;

  return (
    <Card>
      <div className="flex flex-wrap gap-2">
        <Chip
          label="Camera"
          value={armed ? (r.camera?.usingObs ? "OBS Virtual Camera" : (r.camera?.label ?? "on")) : "off"}
          tone={armed ? (r.camera?.usingObs ? "ok" : "warn") : "warn"}
        />
        <Chip label="OBS" value={obsConnected ? "connected" : "not connected"} tone={obsConnected ? "ok" : "warn"} />
        <Chip label="AI model" value={model ? "live" : "demo (passthrough)"} tone={model ? "ok" : "warn"} />
      </div>

      {/* What to expect — stated BEFORE the button, so "nothing happened"
          has something concrete to be compared with. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
        <p className="mb-2 font-semibold text-zinc-100">What happens when you press the button</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            For 2–5 seconds nothing visible changes while the model connects (the pill says
            "warming up").
          </li>
          {model ? (
            <li>
              Then, for about {TEST_SEC} seconds, the preview below turns into <b>retro 80s
              anime</b> — and in OBS, the <b>AI Hijack</b> source appears over your camera.
              Watch OBS's <b>Program</b> view, not the preview.
            </li>
          ) : (
            <li>
              This build has <b>no AI model connected</b>, so the picture won't change style.
              What you should see for {TEST_SEC} seconds: the <b>AI Hijack</b> source appears in
              OBS over your camera, showing the same picture with an <b>"AI-altered"</b> label.
              That proves the OBS wiring; the real effect needs the hosted sign-in.
            </li>
          )}
          <li>Then everything reverts on its own. No viewer is charged for this.</li>
        </ol>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-zinc-800 bg-black">
        <StreamVideo
          stream={r.aiStream ?? r.cameraStream}
          className="aspect-video w-full object-contain"
        />
        <span className="absolute left-3 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-zinc-300">
          {r.aiStream ? "AI output" : armed ? "Your camera (effect not running)" : "Camera off"}
        </span>
        {phase === "running" && (
          <span className="absolute right-3 top-2 rounded bg-brand-600 px-2 py-0.5 text-xs font-semibold">
            {PHASE_LABEL[r.state]}
            {r.state === "LIVE" && r.remainingSec != null ? ` · ${r.remainingSec}s left` : ""}
          </span>
        )}
      </div>

      {r.armError && <p className="text-sm text-red-400">Camera failed: {r.armError}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {outcome && phase === "firing" && (
        <p className="text-sm text-zinc-400">Sent ({outcome}) — waiting for the model…</p>
      )}

      {phase !== "ended" && (
        <div className="flex items-center gap-4">
          <Primary onClick={fire} disabled={!armed || phase === "firing" || phase === "running"}>
            {phase === "firing" || phase === "running" ? "Running…" : `Run the ${TEST_SEC}-second test`}
          </Primary>
          <Skip next={next} label="Skip the test" />
        </div>
      )}

      {phase === "ended" && verdict === null && (
        <div className="space-y-3">
          <p className="font-semibold text-zinc-100">
            {model
              ? "Did your OBS picture turn into 80s anime for about 10 seconds?"
              : 'Did the "AI-altered" layer appear over your camera in OBS?'}
          </p>
          <div className="flex items-center gap-3">
            <Primary onClick={() => { setVerdict("yes"); next(); }}>Yes — it worked</Primary>
            <Secondary onClick={() => setVerdict("no")}>No, I saw nothing</Secondary>
          </div>
        </div>
      )}

      {phase === "ended" && verdict === "no" && (
        <div className="space-y-3 rounded-xl border border-amber-800 bg-amber-950/30 p-4 text-sm text-zinc-200">
          <p className="font-semibold text-amber-200">Let's find out why. Here's what the app saw:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            {!sawLive && (
              <li>
                The effect <b>never went live</b> on this side
                {outcome ? ` (the engine said: ${outcome})` : ""}. The last events were:
                <div className="mt-1 max-h-24 overflow-y-auto rounded bg-black/40 p-2 font-mono text-xs text-zinc-400">
                  {r.logLines.slice(0, 5).map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              </li>
            )}
            {sawLive && (
              <li>
                The effect <b>did go live here</b> — so the model worked and the problem is
                in OBS: the AI Hijack source may be in a different scene than the one you're
                outputting, or sit <b>below</b> your camera. Drag it to the top of the Sources list.
              </li>
            )}
            {!obsConnected && (
              <li>
                <b>OBS isn't connected</b>, so the app can't show the overlay. Go back to
                Connect OBS.
              </li>
            )}
            {r.camera && !r.camera.usingObs && (
              <li>
                The camera in use is <b>{r.camera.label}</b>, not OBS's Virtual Camera. Go back
                to Camera and start the Virtual Camera.
              </li>
            )}
            {!model && (
              <li>
                This build has <b>no AI model</b>: the picture doesn't change style. Look for
                the "AI-altered" label on the overlay, not for anime.
              </li>
            )}
            {sawLive && obsConnected && (
              <li>
                Re-adding the source puts it back in the current scene, on top:
                <div className="mt-1">
                  <Secondary
                    onClick={() =>
                      void d
                        .provisionObs()
                        .then((p) => setOverlayNote(p.ok ? `✓ ${p.detail}` : p.detail))
                        .catch((e) => setOverlayNote(ipcMessage(e)))
                    }
                  >
                    Add the AI Hijack source again
                  </Secondary>
                  {overlayNote && <span className="ml-2 text-xs text-zinc-300">{overlayNote}</span>}
                </div>
              </li>
            )}
          </ul>
          <p className="text-xs text-zinc-400">
            {state.cloudMode
              ? "The hosted service allows one free test per day; if it's used up, the 'Run' button says so. You can always run an effect on yourself from the studio once a viewer has paid for one."
              : "Local mode has no limit — fix the item above and run it again."}
          </p>
          <div className="flex items-center gap-3">
            <Primary onClick={fire} disabled={!armed}>Run it again</Primary>
            <Skip next={next} label="Continue anyway" />
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Step 7: Done ──────────────────────────────────────────────────────────

function DoneStep({ d, state }: { d: RhDesktopSetup; state: SetupState }) {
  const [auto, setAuto] = useState(state.autoLaunch);
  const [finishing, setFinishing] = useState(false);
  const portal = state.portalUrl;
  return (
    <Card>
      <h2 className="text-lg font-bold text-emerald-400">You're set up 🎉</h2>
      {portal ? (
        <>
          <p className="text-zinc-300">Share your viewer page in chat or a panel:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-zinc-900 p-2 text-xs">
              {portal}
            </code>
            <button
              onClick={() => void navigator.clipboard.writeText(portal)}
              className="rounded bg-zinc-800 px-3 py-2 text-xs hover:bg-zinc-700"
            >
              Copy
            </button>
          </div>
        </>
      ) : (
        <p className="text-zinc-300">
          Local mode: viewers use{" "}
          <code className="text-xs">http://127.0.0.1:{state.port}/portal</code>{" "}
          on this machine.
        </p>
      )}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
        <p className="mb-1 font-semibold text-zinc-100">Two things to remember on stream</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Keep the Reality Hijack window open (it can sit behind OBS). It's what runs each
            hijack.
          </li>
          <li>
            Panic: press <Keycap>{PANIC_KEY}</Keycap> from any app, or use the {TRAY_NAME}. The
            effect disappears from your stream at once and new hijacks wait until you press it
            again or click Resume.
          </li>
        </ul>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked);
            void d.setAutoLaunch(e.target.checked);
          }}
        />
        Start Reality Hijack when I log in
      </label>
      {/* Marks setup done and relaunches: from now on the app opens straight
          into the studio, and any key pasted in step 1 is loaded. */}
      <Primary
        disabled={finishing}
        onClick={() => {
          setFinishing(true);
          void d.setupComplete();
        }}
      >
        {finishing ? "Restarting…" : "Open the studio →"}
      </Primary>
    </Card>
  );
}
