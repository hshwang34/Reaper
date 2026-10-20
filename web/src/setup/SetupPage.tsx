// The onboarding wizard — the "≤5 minutes to live" flow (plan M4).
// Renders only inside the Electron shell (window.rhDesktop). Seven steps, each
// skippable where the plan allows; every step reads real state from the main
// process and deep-links back when something fails. "Stream safety" is the one
// step that can't be skipped: it's where the streamer acknowledges the
// platform obligations the product can't carry for them (CONTENT-SAFETY S6).

import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge, DesktopSetupState } from "@rh/shared";
import { desktopBridge } from "../lib/desktop.js";
import { PANIC_KEY, TRAY_NAME } from "../lib/platform.js";
import { acquireCamera } from "../router/decartSession.js";

// The wizard reads everything through the typed preload bridge
// (shared/src/desktopBridge.ts) — no hand-declared window shape here.
type SetupState = DesktopSetupState;
type RhDesktopSetup = DesktopBridge;

const desktop = desktopBridge;

const STEPS = [
  "Sign in",
  "Camera",
  "Connect OBS",
  "Connect tips",
  "Stream safety",
  "Test hijack",
  "Done",
] as const;

export default function SetupPage() {
  const d = desktop();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<SetupState | null>(null);

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
        The setup wizard runs inside the Stream Hijack app.
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
        <h1 className="text-2xl font-bold">Set up Stream Hijack</h1>
        <ol className="mt-4 flex gap-2 text-xs">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`rounded-full px-3 py-1 ${
                i === step
                  ? "bg-brand-600 font-semibold"
                  : i < step
                    ? "bg-emerald-800 text-emerald-200"
                    : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {i < step ? "✓ " : ""}
              {label}
            </li>
          ))}
        </ol>
      </header>

      {step === 0 && <SignInStep d={d} state={state} next={next} />}
      {step === 1 && <CameraStep next={next} />}
      {step === 2 && (
        <ObsStep d={d} state={state} refresh={refresh} next={next} />
      )}
      {step === 3 && <TipsStep state={state} next={next} />}
      {step === 4 && <SafetyStep state={state} next={next} />}
      {step === 5 && <TestStep d={d} next={next} />}
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

function Skip({ next, label }: { next: () => void; label?: string }) {
  return (
    <button onClick={next} className="text-sm text-zinc-500 underline">
      {label ?? "Skip for now"}
    </button>
  );
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
          Signed in as <b className="text-brand-400">{state.login}</b>. Your
          viewer portal and tips run through the Stream Hijack cloud — no API
          keys on this machine.
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
  // setup — camera, OBS, the safety acknowledgement — is still worth doing.
  if (!state.cloudUrl) {
    return (
      <Card>
        <p className="text-zinc-300">
          <b>Hosted sign-in isn't available in this build yet.</b> Stream
          Hijack signs you in with Twitch and runs tips, moderation and the AI
          model from our servers — nothing to configure on your side. That
          service isn't live for this build; you can still set up your camera
          and OBS and try the flow with a passthrough test effect.
        </p>
        <Primary onClick={next}>Continue</Primary>
        {localMode}
      </Card>
    );
  }
  return (
    <Card>
      <p className="text-zinc-300">
        Sign in with Twitch to get your hosted viewer page and tip wiring —
        no config files, no API keys. Your browser will open; the app picks
        the session up automatically (it restarts once, signed in).
      </p>
      <div className="flex items-center gap-4">
        <Primary
          disabled={waiting}
          onClick={() => {
            setWaiting(true);
            void d.signIn().finally(() => setWaiting(false));
          }}
        >
          {waiting ? "Waiting for browser…" : "Sign in with Twitch"}
        </Primary>
      </div>
      {localMode}
    </Card>
  );
}

// ── Step 2: Camera ────────────────────────────────────────────────────────

function CameraStep({ next }: { next: () => void }) {
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  async function grab() {
    setError(null);
    try {
      const { stream, usingObs } = await acquireCamera();
      setStream(stream);
      setLabel(
        usingObs
          ? "OBS Virtual Camera"
          : (stream.getVideoTracks()[0]?.label ?? "camera"),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [stream]);

  return (
    <Card>
      <p className="text-zinc-300">
        Stream Hijack restyles your <b>OBS Virtual Camera</b>. Start it in
        OBS (set its output type to <b>Source</b>, not Program — otherwise the
        AI feeds back into itself) and allow camera access.
      </p>
      {stream && (
        <video
          autoPlay
          muted
          playsInline
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
          className="aspect-video w-full rounded-xl border border-zinc-800 bg-black object-cover"
        />
      )}
      {label && (
        <p className="text-sm text-emerald-400">✓ Capturing {label}</p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-4">
        {!stream ? (
          <Primary onClick={() => void grab()}>Allow camera</Primary>
        ) : (
          <Primary onClick={next}>Looks good — continue</Primary>
        )}
      </div>
    </Card>
  );
}

/** An error thrown in the main process, minus Electron's IPC wrapper
 *  ("Error invoking remote method 'rh:…': Error: "). */
function ipcMessage(e: unknown): string {
  return (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// ── Step 3: OBS ───────────────────────────────────────────────────────────

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
  const [enabling, setEnabling] = useState(false);
  const disc = state.obs.discovery;
  const obsRunning = state.obs.running;

  return (
    <Card>
      {disc === "not-installed" && (
        <>
          <p className="text-zinc-300">
            OBS Studio doesn't seem to be installed (or has never run). Install
            OBS 30+, or add the overlay manually later: create a Browser Source
            pointing at
          </p>
          <code className="block break-all rounded bg-zinc-900 p-2 text-xs">
            {state.viewerUrl}
          </code>
        </>
      )}
      {disc === "disabled" && (
        <>
          <p className="text-zinc-300">
            OBS is installed but its <b>WebSocket server is off</b> — that's
            how the app talks to OBS. We can switch it on for you; OBS only
            reads the setting when it starts, so it has to be closed first.
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
                  else if (r === "no-config") setResult("OBS has never been started on this computer — launch it once, quit, and try again.");
                  else setResult("Enabled. Starting OBS — this page connects on its own.");
                  refresh();
                })
                .catch((e) => setResult(`Couldn't enable it: ${ipcMessage(e)}`))
                .finally(() => setEnabling(false));
            }}
          >
            {enabling ? "Enabling…" : "Enable it for me and start OBS"}
          </Primary>
          {result && <p className="text-sm text-zinc-300">{result}</p>}
        </>
      )}
      {(disc === "found" || disc === "unreadable") && !state.obs.connected && (
        <>
          <p className="text-zinc-300">
            OBS found — it just isn't running. Launch it and the app connects
            on its own.
          </p>
          <Primary
            onClick={() =>
              void d
                .launchObs()
                .then(refresh)
                .catch((e) => setResult(`Couldn't launch OBS: ${ipcMessage(e)}`))
            }
          >
            Launch OBS
          </Primary>
          {result && <p className="text-sm text-red-400">{result}</p>}
        </>
      )}
      {state.obs.connected && (
        <>
          <p className="text-emerald-400">✓ Connected to OBS.</p>
          <p className="text-zinc-300">
            One click creates the hidden <b>AI Hijack</b> overlay source (or
            repairs it if it drifted). It only becomes visible during a paid
            hijack.
          </p>
          <Primary
            onClick={() =>
              void d
                .provisionObs()
                .then((r) => {
                  setResult(r.ok ? `✓ ${r.detail}` : r.detail);
                  refresh();
                })
                .catch((e) => setResult(`Couldn't create the source: ${(e as Error).message}`))
            }
          >
            Create the overlay source
          </Primary>
          {result && <p className="text-sm text-emerald-400">{result}</p>}
        </>
      )}
      <div className="flex items-center gap-4">
        {result && <Primary onClick={next}>Continue</Primary>}
        <Skip next={next} label="Skip — I'll add the Browser Source myself" />
      </div>
    </Card>
  );
}

// ── Step 4: Tips ──────────────────────────────────────────────────────────

function TipsStep({ state, next }: { state: SetupState; next: () => void }) {
  return (
    <Card>
      {state.cloudMode ? (
        <p className="text-zinc-300">
          Connect your <b>Streamlabs</b> account from the dashboard (Settings →
          Connect tips) so real donations trigger hijacks. Until then, test
          hijacks work fine.
        </p>
      ) : (
        <p className="text-zinc-300">
          Local mode: paste your Streamlabs Socket API token in the router
          page's <b>App credentials</b> panel. Real tips then drive hijacks
          exactly like the hosted setup.
        </p>
      )}
      <div className="flex items-center gap-4">
        <Primary onClick={next}>Continue</Primary>
        <Skip next={next} />
      </div>
    </Card>
  );
}

// ── Step 5: Stream safety ─────────────────────────────────────────────────

/** What each platform asks of the streamer when viewers can restyle their
 *  stream with AI (docs/CONTENT-SAFETY.md §1). Plain-language, and every box
 *  must be ticked — this is the step that can't be skipped. */
const SAFETY_CHECKS = [
  {
    id: "own-content",
    text: "Whatever the AI shows on my stream counts as my content under Twitch, YouTube and Kick rules — nudity or sexual content can get my channel banned even if a viewer asked for it.",
  },
  {
    id: "panic",
    text: `I know my panic key (${PANIC_KEY}, or the ${TRAY_NAME}) cuts an effect instantly, and I'll use it if anything looks wrong.`,
  },
  {
    id: "disclosure",
    text: "I'll disclose AI effects where my platform asks: Kick needs it in my title or on screen (the \"AI-altered\" label covers this), and YouTube asks me to tick its altered-content box for realistic changes.",
  },
  {
    id: "likeness",
    text: "Face swaps only use photos viewers have consent for, and never of anyone under 18 or of real public figures. I can require my own approval for every swap.",
  },
] as const;

function SafetyStep({ state, next }: { state: SetupState; next: () => void }) {
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const all = SAFETY_CHECKS.every((c) => ticked[c.id]);
  return (
    <Card>
      <p className="text-zinc-300">
        Viewers' own words and photos are checked by AI moderators before
        anything reaches the model, and an on-device safety guard watches the
        output and cuts it if it turns explicit. Presets are always safe. A
        few things are still on you:
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
          ? "New channels start presets-only. Open custom prompts and photos from the dashboard's Content policy when you're ready."
          : "In local mode you supply the moderation keys (router page → App credentials). Without them, custom prompts and photos stay off."}
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

function TestStep({ d, next }: { d: RhDesktopSetup; next: () => void }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <p className="text-zinc-300">
        Send yourself a 10-second test hijack. Keep the router window armed
        (camera on) and watch your OBS program output take over.
      </p>
      <Primary
        onClick={() => {
          setError(null);
          d.testHijack(
            "Retro 1980s anime cel-shaded style, bold ink outlines, neon sunset gradients",
            10,
          )
            .then(setOutcome)
            .catch((e) => setError((e as Error).message));
        }}
      >
        Fire test hijack (10s)
      </Primary>
      {outcome && <p className="text-sm text-emerald-400">✓ {outcome}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-4">
        {outcome && <Primary onClick={next}>It worked — finish</Primary>}
        <Skip next={next} />
      </div>
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
      <h2 className="text-lg font-bold text-emerald-400">You're live 🎉</h2>
      {portal ? (
        <>
          <p className="text-zinc-300">Share your viewer page in chat:</p>
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
      <p className="text-sm text-zinc-400">
        Panic anytime with <b>{PANIC_KEY}</b> (also in the {TRAY_NAME}) — it kills
        the live hijack and pauses the queue instantly.
      </p>
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
          into the router, and any key pasted in step 1 is loaded. */}
      <Primary
        disabled={finishing}
        onClick={() => {
          setFinishing(true);
          void d.setupComplete();
        }}
      >
        {finishing ? "Restarting…" : "Open Stream Hijack →"}
      </Primary>
    </Card>
  );
}
