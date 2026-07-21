// The onboarding wizard — the "≤5 minutes to live" flow (plan M4).
// Renders only inside the Electron shell (window.rhDesktop). Six steps, each
// skippable where the plan allows; every step reads real state from the main
// process and deep-links back when something fails.

import { useCallback, useEffect, useState } from "react";
import { acquireCamera } from "../router/decartSession.js";

interface SetupState {
  cloudMode: boolean;
  login: string | null;
  cloudUrl: string;
  obs: { discovery: string; connected: boolean };
  keys: Record<string, boolean>;
  port: number;
  viewerUrl: string;
  portalUrl: string | null;
  autoLaunch: boolean;
}

interface RhDesktopSetup {
  setupState(): Promise<SetupState>;
  signIn(): Promise<{ ok: boolean; login?: string }>;
  signOut(): Promise<void>;
  provisionObs(): Promise<{ ok: boolean; detail: string }>;
  launchObs(): Promise<void>;
  testHijack(prompt: string, durationSec: number): Promise<string>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
}

const desktop = () =>
  (window as { rhDesktop?: RhDesktopSetup }).rhDesktop ?? null;

const STEPS = [
  "Sign in",
  "Camera",
  "Connect OBS",
  "Connect tips",
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
        <ol className="mt-4 flex gap-2 text-xs">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`rounded-full px-3 py-1 ${
                i === step
                  ? "bg-fuchsia-600 font-semibold"
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
      {step === 4 && <TestStep d={d} next={next} />}
      {step === 5 && <DoneStep d={d} state={state} />}

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
      className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
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
  if (state.cloudMode) {
    return (
      <Card>
        <p>
          Signed in as <b className="text-fuchsia-400">{state.login}</b>. Your
          viewer portal and tips run through the Reality Hijack cloud — no API
          keys on this machine.
        </p>
        <Primary onClick={next}>Continue</Primary>
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
        <Skip next={next} label="Use local demo mode instead" />
      </div>
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
        Reality Hijack restyles your <b>OBS Virtual Camera</b>. Start it in
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
  const disc = state.obs.discovery;

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
        <p className="text-zinc-300">
          OBS is installed but its <b>WebSocket server is off</b>. In OBS:
          Tools → WebSocket Server Settings → Enable. The app picks it up
          automatically.
        </p>
      )}
      {(disc === "found" || disc === "unreadable") && !state.obs.connected && (
        <>
          <p className="text-zinc-300">
            OBS found — it just isn't running. Launch it and the app connects
            on its own.
          </p>
          <Primary onClick={() => void d.launchObs().then(refresh)}>
            Launch OBS
          </Primary>
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
              void d.provisionObs().then((r) => {
                setResult(r.ok ? `✓ ${r.detail}` : r.detail);
                refresh();
              })
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

// ── Step 5: Test hijack ───────────────────────────────────────────────────

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

// ── Step 6: Done ──────────────────────────────────────────────────────────

function DoneStep({ d, state }: { d: RhDesktopSetup; state: SetupState }) {
  const [auto, setAuto] = useState(state.autoLaunch);
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
        Panic anytime with <b>⌘⇧H</b> (also in the menu-bar icon) — it kills
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
        Start Reality Hijack when I log in
      </label>
      <a
        href="/router"
        className="inline-block rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500"
      >
        Open the router →
      </a>
    </Card>
  );
}
