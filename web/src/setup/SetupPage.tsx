// The onboarding wizard — the "≤5 minutes to live" flow (plan M4; brief
// docs/product/briefs/001-setup-ux.md). Renders only inside the Electron
// shell (window.rhDesktop). Seven steps, each skippable where the plan
// allows; every step reads real state from the main process and deep-links
// back when something fails. "Safety" is the one step that can't be
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
import { FALLBACK, friendlyStreamerError } from "../lib/friendlyError.js";
import { PANIC_KEY, TRAY_NAME } from "../lib/platform.js";
import { acquireCamera, listCameras } from "../router/decartSession.js";
import { StreamVideo, useRouterEngine } from "../router/useRouterEngine.js";
import { Keycap } from "../features/Keycap.js";
import { PAYOUT_COUNTRIES } from "../dashboard/PayoutsPanel.js";
import { btn } from "../studio/ui.js";

// The wizard reads everything through the typed preload bridge
// (shared/src/desktopBridge.ts) — no hand-declared window shape here.
type SetupState = DesktopSetupState;
type RhDesktopSetup = DesktopBridge;

const desktop = desktopBridge;

const STEPS = [
  "Sign in",
  "Connect OBS",
  "Pick your camera",
  "Get paid",
  "Safety",
  "Test hijack",
  "Done",
] as const;

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** What the streamer got done, for the last step's checklist. Lifted here so
 *  steps (which unmount when you move on) can report into it. */
type Progress = { overlay: boolean; camera: boolean; test: "passed" | "skipped" | null };

export default function SetupPage() {
  const d = desktop();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<SetupState | null>(null);
  // The device the streamer settled on in the camera step; the test step
  // arms the same one so what they previewed is what gets restyled.
  const [cameraId, setCameraId] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<Progress>({ overlay: false, camera: false, test: null });
  const mark = useCallback((p: Partial<Progress>) => setProgress((cur) => ({ ...cur, ...p })), []);
  // The test step sets this while an effect is starting or playing: leaving
  // mid-run would strand the router page.
  const [backLocked, setBackLocked] = useState(false);

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
      <div className="grid h-screen place-items-center px-6 text-center text-zinc-400">
        Setup only runs in the Stream Hijack app. Download it from streamhijack.com.
      </div>
    );
  }
  if (!state) {
    return (
      <div className="grid h-screen place-items-center text-zinc-400">
        Loading setup…
      </div>
    );
  }

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  return (
    <div className="mx-auto max-w-2xl p-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">Set up Stream Hijack</h1>
        <Stepper step={step} />
      </header>

      {step === 0 && <SignInStep d={d} state={state} next={next} />}
      {step === 1 && (
        <ObsStep d={d} state={state} refresh={refresh} next={next} onOverlay={() => mark({ overlay: true })} />
      )}
      {step === 2 && (
        <CameraStep
          d={d}
          state={state}
          refresh={refresh}
          next={next}
          onChosen={(id) => {
            setCameraId(id);
            mark({ camera: true });
          }}
        />
      )}
      {step === 3 && <PayoutsStep d={d} state={state} next={next} />}
      {step === 4 && <SafetyStep state={state} next={next} />}
      {step === 5 && (
        <TestStep
          d={d}
          state={state}
          cameraId={cameraId}
          next={(passed) => {
            mark({ test: passed ? "passed" : "skipped" });
            next();
          }}
          onBusy={setBackLocked}
        />
      )}
      {step === 6 && <DoneStep d={d} state={state} progress={progress} />}

      {step > 0 && step < STEPS.length - 1 && (
        <button
          onClick={() => setStep((s) => s - 1)}
          disabled={backLocked}
          className={`${btn.ghost} mt-6 disabled:cursor-not-allowed disabled:opacity-40`}
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
      <span className="font-mono text-xs text-zinc-400">
        Step {step + 1} of {STEPS.length}
      </span>
      <span className="font-semibold text-zinc-100">{STEPS[step]}</span>
      <ol className="ml-2 flex min-w-0 flex-1 gap-1" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            title={label}
            aria-current={i === step ? "step" : undefined}
            className={`h-1.5 flex-1 rounded-full ${
              i < step ? "bg-emerald-600" : i === step ? "bg-brand-600" : "bg-zinc-800"
            }`}
          />
        ))}
      </ol>
      {step + 1 < STEPS.length && (
        <span className="hidden text-xs text-zinc-400 sm:inline">Next: {STEPS[step + 1]}</span>
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

/** A compact fact row: "OBS · connected" — single line, fixed shape. */
function Chip({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "off" }) {
  const color =
    tone === "ok" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : "text-zinc-400";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs">
      <span className="text-zinc-400">{label}</span>
      <span className={`font-semibold ${color}`}>{value}</span>
    </span>
  );
}

/** Wizard errors: IPC wrappers, HTTP codes and camera exceptions all become
 *  calm sentences (lib/friendlyError). Never the raw text. */
const say = friendlyStreamerError;

const CAMERA_FALLBACK =
  "Couldn't open the camera. Check that nothing else is using it and that you allowed camera access, then try again.";
/** Camera errors read better with a camera-specific fallback than "our side". */
function cameraError(e: unknown): string {
  const m = say(e);
  return m === FALLBACK ? CAMERA_FALLBACK : m;
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
  const [slow, setSlow] = useState(false);
  const [decartKey, setDecartKey] = useState("");
  const [saved, setSaved] = useState(false);

  // A sign-in that takes a minute usually means the browser tab was closed.
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 60_000);
    return () => clearTimeout(t);
  }, [waiting]);

  if (state.cloudMode) {
    return (
      <Card>
        <p>
          You're signed in as <b className="text-brand-400">{state.login}</b>. Your hijack page,
          payments and AI are all handled for you. Nothing to install or paste.
        </p>
        <button className={btn.primary} onClick={next}>Continue</button>
      </Card>
    );
  }
  // Pasted-keys local mode: a dev fallback only (repo runs, RH_LOCAL_MODE=1).
  // Streamers never see a key field — the hosted control plane holds the
  // AI key for them.
  const localMode = state.localModeAllowed && (
    <details className="text-sm text-zinc-400">
      <summary className="cursor-pointer">Developer: use your own AI key</summary>
      <div className="mt-3 space-y-3">
        {state.keys.decartApiKey || saved ? (
          <p className="text-emerald-400">AI key saved. It loads when setup finishes.</p>
        ) : (
          <div className="flex gap-2">
            <input
              type="password"
              value={decartKey}
              onChange={(e) => setDecartKey(e.target.value)}
              placeholder="AI key"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            />
            <button
              disabled={!decartKey.trim()}
              onClick={() =>
                void d.saveKeys({ decartApiKey: decartKey.trim() }).then(() => setSaved(true))
              }
              className={btn.secondary}
            >
              Save
            </button>
          </div>
        )}
        <button className={btn.ghost} onClick={next}>Continue with my own key</button>
      </div>
    </details>
  );

  // This build has no control plane baked in (nothing deployed yet): say so.
  // The rest of setup — OBS, camera, the safety acknowledgement — is still
  // worth doing.
  if (!state.cloudUrl) {
    return (
      <Card>
        <p className="text-zinc-300">
          <b>Sign-in isn't available in this version yet.</b> You can still set up OBS and your
          camera and try a test.
        </p>
        <button className={btn.primary} onClick={next}>Continue</button>
        {localMode}
      </Card>
    );
  }
  return (
    <Card>
      <p className="text-zinc-300">
        Sign in with Twitch to get your hijack page and start taking payments. Your browser
        opens. Come back here when you're done.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className={btn.primary}
          disabled={waiting}
          onClick={() => {
            setWaiting(true);
            void d.signIn().finally(() => setWaiting(false));
          }}
        >
          {waiting ? "Waiting for your browser…" : "Sign in with Twitch"}
        </button>
        {waiting && (
          <button className={btn.ghost} onClick={() => void d.cancelSignIn()}>
            Cancel
          </button>
        )}
      </div>
      {waiting && (
        <p className="text-sm text-zinc-300">
          Waiting for your browser… The app restarts once after you sign in; your place is saved.
        </p>
      )}
      {slow && <p className="text-sm text-amber-300">Still waiting. Try the button again.</p>}
      {localMode}
    </Card>
  );
}

// ── Step 2: Connect OBS ───────────────────────────────────────────────────

const SWITCH_ON_TEXT =
  "OBS needs to let Stream Hijack control it. Close OBS and we'll switch it on for you.";

function ObsStep({
  d,
  state,
  refresh,
  next,
  onOverlay,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  refresh: () => void;
  next: () => void;
  onOverlay: () => void;
}) {
  const [result, setResult] = useState<string | null>(null);
  const [resultTone, setResultTone] = useState<"ok" | "bad">("ok");
  const [overlayOk, setOverlayOk] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [manual, setManual] = useState(false);
  const [slow, setSlow] = useState(false);
  const disc = state.obs.discovery;
  const obsRunning = state.obs.running;
  const connecting =
    (disc === "found" || disc === "unreadable") && !state.obs.connected && obsRunning;

  // "Connecting…" that outlasts a few seconds gets a hint.
  useEffect(() => {
    if (!connecting) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, [connecting]);

  const show = (text: string, tone: "ok" | "bad") => {
    setResult(text);
    setResultTone(tone);
  };

  return (
    <Card>
      <p className="text-sm text-zinc-400">
        Stream Hijack talks to OBS to show and hide the effect. Nothing else in your scenes
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
                  ? "open, not connected"
                  : "not open"
          }
          tone={state.obs.connected ? "ok" : disc === "not-installed" ? "warn" : "off"}
        />
        <Chip
          label="Overlay"
          value={overlayOk ? "added" : "not added yet"}
          tone={overlayOk ? "ok" : "off"}
        />
      </div>

      {disc === "not-installed" && (
        <>
          <p className="text-zinc-300">We can't find OBS on this computer.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button className={btn.primary} onClick={() => void d.openExternal("https://obsproject.com")}>
              Get OBS
            </button>
            <button className={btn.ghost} onClick={() => setManual(true)}>
              I installed it somewhere else
            </button>
          </div>
          {manual && (
            <>
              <p className="text-sm text-zinc-300">
                Open OBS yourself and we'll connect. To add the overlay by hand later, add a
                “Browser” source in OBS and paste this link:
              </p>
              <code className="block break-all rounded bg-zinc-900 p-2 text-xs">
                {state.viewerUrl}
              </code>
            </>
          )}
        </>
      )}
      {disc === "disabled" && (
        <>
          <p className={obsRunning ? "text-sm text-amber-300" : "text-zinc-300"}>{SWITCH_ON_TEXT}</p>
          <button
            className={btn.primary}
            disabled={obsRunning || enabling}
            onClick={() => {
              setEnabling(true);
              setResult(null);
              void d
                .enableObsWebsocket()
                .then((r) => {
                  if (r === "obs-running") show("OBS is still open. Close it and try again.", "bad");
                  else if (r === "no-config") show("Open OBS once, close it, then try again.", "bad");
                  else show("Done. Starting OBS now.", "ok");
                  refresh();
                })
                .catch((e) => show(`Couldn't turn it on. ${say(e)}`, "bad"))
                .finally(() => setEnabling(false));
            }}
          >
            {enabling ? "Switching on…" : "Switch it on"}
          </button>
          {!obsRunning && (
            <p className="text-sm text-zinc-400">
              Or do it yourself in OBS: “Tools → WebSocket Server Settings → Enable”.
            </p>
          )}
          {result && (
            <p className={`text-sm ${resultTone === "ok" ? "text-zinc-300" : "text-red-300"}`}>{result}</p>
          )}
        </>
      )}
      {(disc === "found" || disc === "unreadable") && !state.obs.connected && (
        <>
          <p className="text-zinc-300">
            {obsRunning
              ? "OBS is open. Connecting…"
              : "OBS is installed but not open. Start it and we'll connect."}
          </p>
          {slow && (
            <p className="text-sm text-amber-300">
              Still working. If this doesn't connect, check that OBS is up to date.
            </p>
          )}
          {!obsRunning && (
            <button
              className={btn.primary}
              onClick={() =>
                void d
                  .launchObs()
                  .then(refresh)
                  .catch(() => show("Couldn't start OBS. Open it yourself and we'll connect.", "bad"))
              }
            >
              Start OBS
            </button>
          )}
          {result && <p className="text-sm text-red-300">{result}</p>}
        </>
      )}
      {state.obs.connected && (
        <>
          <p className="text-emerald-400">✓ Connected to OBS.</p>
          <p className="text-zinc-300">
            We'll add the AI Hijack overlay to your current scene. It stays hidden until a
            hijack is playing.
          </p>
          <button
            className={overlayOk ? btn.secondary : btn.primary}
            onClick={() =>
              void d
                .provisionObs()
                .then((r) => {
                  setOverlayOk(r.ok);
                  if (r.ok) onOverlay();
                  // r.detail is describePlacements(): 'Installed in "Scene" over "Cam"'.
                  show(r.ok ? `✓ ${r.detail}` : "Couldn't add the overlay. Make sure OBS is open, then try again.", r.ok ? "ok" : "bad");
                  refresh();
                })
                .catch(() => show("Couldn't add the overlay. Make sure OBS is open, then try again.", "bad"))
            }
          >
            {overlayOk ? "Add it again" : "Add the overlay"}
          </button>
          {result && (
            <p className={`text-sm ${resultTone === "ok" ? "text-emerald-400" : "text-red-300"}`}>{result}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {/* Primary only once the step is done. */}
        <button className={overlayOk ? btn.primary : btn.ghost} disabled={!overlayOk} onClick={next}>
          Continue
        </button>
        <button className={btn.ghost} onClick={next}>
          Skip. I'll add it myself
        </button>
      </div>
    </Card>
  );
}

// ── Step 3: Pick your camera ──────────────────────────────────────────────

/** gear → Output type → Source: the one setting that prevents the
 *  hall-of-mirrors feedback loop. Inline SVG so it works offline. */
function VirtualCamHint() {
  return (
    <div
      role="note"
      className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4"
    >
      <p className="text-base font-bold text-amber-100">
        In OBS, set the Virtual Camera's output type to <b className="underline">Source</b>, not
        Program. Otherwise you'll see yourself inside yourself.
      </p>
      <svg
        viewBox="0 0 360 64"
        role="img"
        aria-label="In OBS, click the gear next to Start Virtual Camera, then set Output type to Source"
        className="mt-3 w-full max-w-md"
      >
        <g fill="none" stroke="currentColor" strokeWidth="1.6" className="text-amber-200">
          <circle cx="32" cy="32" r="9" />
          <circle cx="32" cy="32" r="20" strokeDasharray="6 5" />
          <path d="M66 32h40m-8-6 8 6-8 6" />
          <rect x="114" y="14" width="104" height="36" rx="8" />
          <path d="M224 32h40m-8-6 8 6-8 6" />
          <rect x="272" y="14" width="80" height="36" rx="8" className="fill-amber-300/20" />
        </g>
        <g fontSize="12" fill="currentColor" className="text-amber-100" fontFamily="system-ui, sans-serif">
          <text x="166" y="36" textAnchor="middle">Output type</text>
          <text x="312" y="36" textAnchor="middle" fontWeight="700">Source</text>
          <text x="32" y="62" textAnchor="middle" fontSize="10">gear</text>
        </g>
      </svg>
    </div>
  );
}

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
      setError(cameraError(e));
    }
  }

  async function startVirtualCam() {
    setStarting(true);
    setNote(null);
    try {
      const r = await d.startVirtualCamera();
      if (r === "obs-not-connected") {
        setNote("OBS isn't connected. Go back to the last step.");
        return;
      }
      setNote("Virtual Camera is on.");
      refresh();
      // The device takes a moment to appear to the OS after OBS starts it.
      await new Promise((res) => setTimeout(res, 1200));
      await grab();
    } catch {
      setNote("Couldn't start the Virtual Camera. Start it in OBS and press the button below.");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [stream]);

  const needsStart = !stream && obsConnected && vcam === false;

  return (
    <Card>
      {/* The loudest thing on the step: skipping it ruins the picture. */}
      <VirtualCamHint />
      <p className="text-zinc-300">
        Stream Hijack uses OBS's Virtual Camera, so the effect covers exactly what chat sees:
        your scene, framing and filters.
      </p>
      <div className="flex flex-wrap gap-2">
        <Chip label="OBS" value={obsConnected ? "connected" : "not connected"} tone={obsConnected ? "ok" : "warn"} />
        <Chip
          label="Virtual Camera"
          value={vcam === true ? "on" : vcam === false ? "off" : "can't tell"}
          tone={vcam === true ? "ok" : vcam === false ? "warn" : "off"}
        />
        {stream && <Chip label="Capturing" value={label} tone={usingObs ? "ok" : "warn"} />}
      </div>

      {!stream && !obsConnected && (
        <p className="text-sm text-amber-300">
          OBS isn't connected. Effects would cover your raw webcam, not your OBS scene. Go back
          and connect OBS first.
        </p>
      )}
      {needsStart && (
        <p className="text-sm text-amber-300">
          OBS's Virtual Camera is off. Start it from here, or in OBS under Controls → Start
          Virtual Camera.
        </p>
      )}
      {!stream && obsConnected && vcam !== false && (
        <p className="text-sm text-zinc-400">
          {IS_MAC ? "macOS" : "Windows"} will ask to use the camera once. Say yes. The preview
          shows what chat sees.
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
          ✓ This is your OBS Virtual Camera. Effects will play over it.
        </p>
      )}
      {stream && !usingObs && (
        <>
          <p className="text-sm text-amber-300">
            This is <b>{label}</b>, not the OBS Virtual Camera. Not seeing it? Start the Virtual
            Camera in OBS, then pick it below.
          </p>
          {cams.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-zinc-300">
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
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {note && <p className="text-sm text-zinc-300">{note}</p>}

      <div className="flex flex-wrap items-center gap-3">
        {needsStart && (
          <button className={btn.primary} disabled={starting} onClick={() => void startVirtualCam()}>
            {starting ? "Starting Virtual Camera…" : "Start Virtual Camera"}
          </button>
        )}
        {!stream && !needsStart && (
          <button className={btn.primary} onClick={() => void grab()}>
            {obsConnected ? "Use the OBS Virtual Camera" : "Pick a camera anyway"}
          </button>
        )}
        {needsStart && (
          <button className={btn.secondary} onClick={() => void grab()}>
            I started it myself
          </button>
        )}
        {stream && (
          <button className={btn.primary} onClick={next}>
            {usingObs ? "Looks good, continue" : "Use it anyway, continue"}
          </button>
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
      d.payouts().then((p) => alive && setInfo(p)).catch((e) => alive && setError(say(e)));
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
          Payments aren't on in this version. You can still try effects on yourself from the
          studio. Nothing is charged.
        </p>
        <button className={btn.primary} onClick={next}>Continue</button>
      </Card>
    );
  }

  const ready = info !== "loading" && info?.enabled;
  const started = info !== "loading" && info?.started && !info.enabled;
  const unavailable = info !== "loading" && (!info || !info.configured);
  // The step's one filled button is the thing to do: Stripe, until it's done.
  const todo = info !== "loading" && info?.configured && !info.enabled;

  return (
    <Card>
      <p className="text-zinc-300">
        Chat pays by card on your hijack page. <b>$1 buys 1 second.</b> Stripe pays your share
        to your bank. Stripe also takes our fee, which covers the AI time plus 5%. You set up a
        Stripe account once. Stripe handles your ID and bank details. We never see them.
      </p>
      <div className="flex flex-wrap gap-2">
        <Chip
          label="Payouts"
          value={
            info === "loading"
              ? "checking…"
              : unavailable
                ? "not available yet"
                : info?.enabled
                  ? "ready"
                  : info?.started
                    ? "Stripe is checking your details"
                    : "not set up"
          }
          tone={ready ? "ok" : started ? "warn" : "off"}
        />
      </div>

      {unavailable && (
        <p className="text-sm text-zinc-400">
          Payments aren't available in this version. Skip this step.
        </p>
      )}
      {ready && (
        <p className="text-sm text-emerald-400">✓ Payouts ready. Chat can pay on your page.</p>
      )}
      {started && (
        <p className="text-sm text-amber-300">
          Stripe is still checking your details. Keep going. This updates by itself. If Stripe
          needs more from you, finish it from your dashboard.
        </p>
      )}
      {todo && (
        <div className="flex flex-wrap items-center gap-3">
          {!info.started && (
            <label className="flex items-center gap-2 text-sm text-zinc-300">
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
              <span className="text-xs text-zinc-400">Where your bank is.</span>
            </label>
          )}
          <button
            className={btn.primary}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void d
                .startPayouts(country)
                .catch((e) => setError(say(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Opening Stripe…" : info.started ? "Continue Stripe setup" : "Set up payouts with Stripe"}
          </button>
          <span className="text-xs text-zinc-400">Opens in your browser; come back here after.</span>
        </div>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <p className="text-sm text-zinc-300">
        Until payouts are ready, chat can't pay you. Test hijacks still work.
      </p>
      <div className="flex items-center gap-3">
        {/* Primary only once there's nothing left to do here. */}
        <button className={todo || info === "loading" ? btn.ghost : btn.primary} onClick={next}>
          Continue
        </button>
      </div>
    </Card>
  );
}

// ── Step 5: Safety ────────────────────────────────────────────────────────

/** What each platform asks of the streamer when viewers can restyle their
 *  stream with AI (docs/CONTENT-SAFETY.md §1). The legal wording of each box
 *  is verbatim (it's an acknowledgement); the bold headline above it is the
 *  plain-language handle. Every box must be ticked — this is the step that
 *  can't be skipped. */
const SAFETY_CHECKS: { id: string; headline: string; text: React.ReactNode }[] = [
  {
    id: "own-content",
    headline: "You own what's on stream",
    text: "Whatever the AI shows on my stream counts as my content under Twitch, YouTube and Kick rules — nudity or sexual content can get my channel banned even if a viewer asked for it.",
  },
  {
    id: "panic",
    headline: "Know your panic key",
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
    headline: "Tell your viewers it's AI",
    text: "I'll disclose AI effects where my platform asks: Kick needs it in my title or on screen (the \"AI-altered\" label covers this), and YouTube asks me to tick its altered-content box for realistic changes.",
  },
  {
    id: "likeness",
    headline: "Photos need consent",
    text: "Face swaps only use photos viewers have consent for, and never of anyone under 18 or of real public figures. I can require my own approval for every swap.",
  },
];

function SafetyStep({ state, next }: { state: SetupState; next: () => void }) {
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const all = SAFETY_CHECKS.every((c) => ticked[c.id]);
  return (
    <Card>
      <p className="text-zinc-300">
        Viewers always write their own prompt and can add a photo. We check every word and
        photo before it reaches your stream, and before anyone pays. The effects on your page
        are examples, not the only options. A few things are still your job:
      </p>
      <div className="space-y-3">
        {SAFETY_CHECKS.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-start gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={Boolean(ticked[c.id])}
              onChange={(e) => setTicked({ ...ticked, [c.id]: e.target.checked })}
              className="mt-1"
            />
            <span>
              <b className="block text-base text-zinc-100">{c.headline}</b>
              {c.text}
            </span>
          </label>
        ))}
      </div>
      <p className="text-sm text-zinc-400">
        {state.cloudMode
          ? "You can tighten this any time in your studio or dashboard: approve each request first, limit photos to scenes and objects, or turn off custom ideas."
          : "In this version, custom ideas and photos stay off until safety checks are set up."}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button className={btn.primary} onClick={next} disabled={!all}>
          I understand, continue
        </button>
        {!all && <span className="text-sm text-zinc-400">Tick all four to continue.</span>}
      </div>
    </Card>
  );
}

// ── Step 6: Test hijack ───────────────────────────────────────────────────

const TEST_PROMPT = "Retro 1980s anime cel-shaded style, bold ink outlines, neon sunset gradients";
const TEST_SEC = 10;
/** The model usually answers in 2–5 s; the visible countdown starts here. */
const WARMUP_SEC = 5;

const PHASE_LABEL: Record<RouterState, string> = {
  OFFLINE: "camera off",
  IDLE: "ready",
  AUTHORIZING: "starting",
  CONNECTING: "connecting",
  BUFFERING: "warming up",
  LIVE: "LIVE",
  TEARDOWN: "going back to normal",
};

/** The wizard IS the router here (useRouterEngine): it arms the camera the
 *  streamer picked, fires the free test, shows the AI's output inline,
 *  and then asks the only question that matters — did you see it? */
function TestStep({
  d,
  state,
  cameraId,
  next,
  onBusy,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  cameraId: string | undefined;
  next: (passed: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const r = useRouterEngine();
  const [phase, setPhase] = useState<"idle" | "firing" | "running" | "ended">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sawLive, setSawLive] = useState(false);
  const [verdict, setVerdict] = useState<"yes" | "no" | null>(null);
  const [overlayNote, setOverlayNote] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const armedOnce = useRef(false);

  useEffect(() => {
    if (armedOnce.current) return;
    armedOnce.current = true;
    void r.arm(cameraId);
  }, [r, cameraId]);

  // Leaving mid-run would strand the router page: the parent disables Back.
  useEffect(() => {
    onBusy(phase === "firing" || phase === "running");
    return () => onBusy(false);
  }, [phase, onBusy]);

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

  // Seconds since the press, for the visible "Starting… 3".
  useEffect(() => {
    if (phase !== "firing" && phase !== "running") return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  const armed = r.cameraStream !== null && r.state !== "OFFLINE";
  const model = state.decartEnabled;
  const warming = (phase === "firing" || phase === "running") && r.state !== "LIVE" && r.state !== "TEARDOWN";
  const countdown = Math.max(0, WARMUP_SEC - elapsed);

  function fire() {
    setError(null);
    setOutcome(null);
    setSawLive(false);
    setVerdict(null);
    setPhase("firing");
    d.testHijack(TEST_PROMPT, TEST_SEC)
      .then(setOutcome)
      .catch((e) => {
        setError(say(e));
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
        {!model && <Chip label="Mode" value="Demo mode" tone="warn" />}
      </div>

      {/* The loudest line on the step: Preview shows the wrong picture. */}
      <p className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-base font-bold text-amber-100">
        Watch OBS's Program view, not the Preview.
      </p>

      {/* What to expect — stated BEFORE the button, so "nothing happened"
          has something concrete to be compared with. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
        <p className="mb-2 font-semibold text-zinc-100">What happens when you press the button</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            For 2–5 seconds nothing visible changes while the AI starts up (the label says
            "warming up").
          </li>
          {model ? (
            <li>
              Then, for about {TEST_SEC} seconds, the preview below turns into <b>80s Anime</b>,
              and in OBS the <b>AI Hijack</b> overlay appears over your camera.
            </li>
          ) : (
            <li>
              This version has <b>no AI connected</b>, so the picture won't change style. For{" "}
              {TEST_SEC} seconds you should see the <b>AI Hijack</b> overlay appear in OBS over
              your camera, showing the same picture with an <b>"AI-altered"</b> label. That
              proves the OBS connection; the real effect needs you to sign in.
            </li>
          )}
          <li>Then everything goes back to normal on its own. Nobody is charged for this.</li>
        </ol>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-zinc-800 bg-black">
        <StreamVideo
          stream={r.aiStream ?? r.cameraStream}
          className="aspect-video w-full object-contain"
        />
        <span className="absolute left-3 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-zinc-200">
          {r.aiStream ? "Effect" : armed ? "Your camera" : "Camera off"}
        </span>
        {(phase === "running" || phase === "firing") && (
          <span
            role="status"
            className="absolute right-3 top-2 rounded bg-brand-600 px-2 py-0.5 text-sm font-semibold"
          >
            {warming
              ? countdown > 0
                ? `Starting… ${countdown}`
                : "Starting…"
              : `${PHASE_LABEL[r.state]}${r.state === "LIVE" && r.remainingSec != null ? ` · ${r.remainingSec}s left` : ""}`}
          </span>
        )}
      </div>

      {r.armError && <p className="text-sm text-red-300">{cameraError(r.armError)}</p>}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {outcome && phase === "firing" && (
        <p className="text-sm text-zinc-300">Sent. Waiting for the AI…</p>
      )}

      {phase !== "ended" && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            className={btn.primary}
            onClick={fire}
            disabled={!armed || phase === "firing" || phase === "running"}
          >
            {phase === "firing" || phase === "running" ? "Running…" : `Run the ${TEST_SEC}-second test`}
          </button>
          <button
            className={btn.ghost}
            disabled={phase === "firing" || phase === "running"}
            onClick={() => next(false)}
          >
            Skip the test
          </button>
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
            <button className={btn.primary} onClick={() => { setVerdict("yes"); next(true); }}>
              Yes — it worked
            </button>
            <button className={btn.secondary} onClick={() => setVerdict("no")}>No, I saw nothing</button>
          </div>
        </div>
      )}

      {phase === "ended" && verdict === "no" && (
        <div className="space-y-3 rounded-xl border border-amber-800 bg-amber-950/30 p-4 text-sm text-zinc-200">
          <p className="font-semibold text-amber-200">Let's find out why. Here's what the app saw:</p>
          <ul className="list-disc space-y-1.5 pl-5">
            {!sawLive && (
              <li>
                The effect <b>never started</b> on this side. Run the test again, and make
                sure hijacks aren't paused.
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-zinc-400">Show details</summary>
                  {outcome && <div className="mt-1 text-xs text-zinc-400">Result: {say(outcome)}</div>}
                  <div className="mt-1 max-h-24 overflow-y-auto rounded bg-black/40 p-2 font-mono text-xs text-zinc-400">
                    {r.logLines.slice(0, 5).map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                </details>
              </li>
            )}
            {sawLive && (
              <li>
                The effect <b>did go live here</b>, so the AI worked and the problem is in
                OBS: the AI Hijack overlay may be in a different scene than the one you're
                streaming, or sit <b>below</b> your camera. Drag it to the top of the Sources
                list.
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
                to Pick your camera and start the Virtual Camera.
              </li>
            )}
            {!model && (
              <li>
                This version has <b>no AI connected</b>: the picture doesn't change style.
                Look for the "AI-altered" label on the overlay, not for anime.
              </li>
            )}
            {sawLive && obsConnected && (
              <li>
                Add the overlay again. This puts it back on top in your current scene.
                <div className="mt-1">
                  <button
                    className={btn.secondary}
                    onClick={() =>
                      void d
                        .provisionObs()
                        .then((p) => setOverlayNote(p.ok ? `✓ ${p.detail}` : "Couldn't add the overlay. Make sure OBS is open, then try again."))
                        .catch((e) => setOverlayNote(say(e)))
                    }
                  >
                    Add the AI Hijack overlay again
                  </button>
                  {overlayNote && <span className="ml-2 text-xs text-zinc-300">{overlayNote}</span>}
                </div>
              </li>
            )}
          </ul>
          <p className="text-sm text-zinc-300">
            {state.cloudMode
              ? "You get one free test a day. If it's used, the button says so. You can still try effects on yourself from the studio later."
              : "There's no limit in this version. Fix the item above and run it again."}
          </p>
          <div className="flex items-center gap-3">
            <button className={btn.primary} onClick={fire} disabled={!armed}>Run it again</button>
            <button className={btn.ghost} onClick={() => next(false)}>Continue anyway</button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Step 7: Done ──────────────────────────────────────────────────────────

function DoneStep({
  d,
  state,
  progress,
}: {
  d: RhDesktopSetup;
  state: SetupState;
  progress: Progress;
}) {
  const [auto, setAuto] = useState(state.autoLaunch);
  const [finishing, setFinishing] = useState(false);
  const [payoutsReady, setPayoutsReady] = useState<boolean | null>(null);
  const portal = state.portalUrl;

  useEffect(() => {
    if (!state.cloudMode) return;
    void d.payouts().then((p) => setPayoutsReady(Boolean(p?.enabled))).catch(() => setPayoutsReady(false));
  }, [d, state.cloudMode]);

  const items: { ok: boolean; text: string }[] = [
    { ok: state.obs.connected, text: state.obs.connected ? "OBS connected" : "OBS not connected" },
    { ok: progress.overlay, text: progress.overlay ? "Overlay added" : "Overlay not added" },
    { ok: progress.camera, text: progress.camera ? "Camera chosen" : "Camera not chosen" },
    state.cloudMode
      ? payoutsReady
        ? { ok: true, text: "Payouts ready" }
        : { ok: false, text: "Payouts not set up. Chat can't pay yet" }
      : { ok: false, text: "Payments not on in this version" },
    { ok: true, text: "Safety rules acknowledged" },
    progress.test === "passed"
      ? { ok: true, text: "Test hijack worked" }
      : { ok: false, text: progress.test === "skipped" ? "Test hijack skipped" : "Test hijack not run" },
  ];

  return (
    <Card>
      <h2 className="text-lg font-bold text-emerald-400">You're all set.</h2>
      <ul className="space-y-1 text-sm" aria-label="What's set up">
        {items.map((it) => (
          <li key={it.text} className={it.ok ? "text-zinc-200" : "text-amber-300"}>
            <span aria-hidden>{it.ok ? "✓ " : "– "}</span>
            {it.text}
          </li>
        ))}
      </ul>
      {portal ? (
        <>
          <p className="text-zinc-300">Share your hijack page in chat or a panel:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-zinc-900 p-2 text-xs">
              {portal}
            </code>
            <button
              onClick={() => void navigator.clipboard.writeText(portal)}
              className={btn.secondary}
            >
              Copy
            </button>
          </div>
        </>
      ) : (
        <p className="text-zinc-300">
          Chat can't reach this version. It only runs on your computer.
        </p>
      )}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
        <p className="mb-1 font-semibold text-zinc-100">Two things to remember on stream</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Keep the Stream Hijack window open (it can sit behind OBS). It's what runs each
            hijack.
          </li>
          <li>
            Panic key: press <Keycap>{PANIC_KEY}</Keycap> from any app, or use the {TRAY_NAME}.
            The effect disappears from your stream at once and new hijacks wait until you
            press it again or click Resume.
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
        Start Stream Hijack when I log in
      </label>
      {/* Marks setup done and relaunches: from now on the app opens straight
          into the studio, and any key pasted in step 1 is loaded. */}
      <button
        className={btn.primary}
        disabled={finishing}
        onClick={() => {
          setFinishing(true);
          void d.setupComplete();
        }}
      >
        {finishing ? "Opening the studio…" : "Open the studio"}
      </button>
    </Card>
  );
}
