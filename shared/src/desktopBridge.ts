// The Electron preload ↔ renderer contract, typed ONCE.
//
// The desktop app exposes two globals to the router window via contextBridge:
//   window.rhAuth    — the per-install privilege token (string)
//   window.rhDesktop — this interface (keys/settings IPC + the setup wizard)
// Before this file, preload.ts, RouterPage and SetupPage each re-declared the
// shape by hand and drifted independently. Now preload implements it
// (`satisfies DesktopBridge`) and the pages read it through one accessor
// (web/src/lib/desktop.ts), so a renamed IPC channel is a compile error on
// both sides instead of an undefined-function at runtime.
//
// Rules the shape encodes: secrets flow renderer → main only. Status comes
// back as booleans, never values.

/** Everything the setup wizard needs to render its checklist. */
export interface DesktopSetupState {
  cloudMode: boolean;
  login: string | null;
  /** The hosted control plane baked into this build, or null when it has
   *  none — then the wizard says hosted sign-in isn't available yet. */
  cloudUrl: string | null;
  /** Pasted-keys local mode is a dev fallback (repo runs, RH_LOCAL_MODE=1),
   *  never something the wizard offers streamers. */
  localModeAllowed: boolean;
  obs: {
    discovery: string;
    connected: boolean;
    running: boolean;
    /** OBS's Virtual Camera output: null when OBS isn't connected (unknown). */
    virtualCamActive: boolean | null;
  };
  /** A real model is wired up (cloud mode, or a pasted Decart key): a test
   *  hijack restyles the camera. Otherwise it's passthrough + the AI label. */
  decartEnabled: boolean;
  /** Which credentials are configured — booleans only, no secret values. */
  keys: Record<string, boolean>;
  port: number;
  viewerUrl: string;
  portalUrl: string | null;
  autoLaunch: boolean;
}

export interface DesktopBridge {
  /** Which credentials are configured (booleans only — no secret values). */
  keysStatus(): Promise<Record<string, boolean>>;
  /** Save pasted credentials (empty fields are left unchanged). */
  saveKeys(keys: Record<string, string>): Promise<void>;
  /** Relaunch the app so the bridge picks up new credentials. */
  relaunch(): Promise<void>;

  // ── Setup wizard surface ────────────────────────────────────────────────
  setupState(): Promise<DesktopSetupState>;
  /** Loopback OAuth via the system browser; resolves once signed in. */
  signIn(): Promise<{ ok: boolean; login?: string }>;
  signOut(): Promise<void>;
  /** Create/repair the hidden OBS Browser Source now. */
  provisionObs(): Promise<{ ok: boolean; detail: string }>;
  launchObs(): Promise<void>;
  /** Switch obs-websocket on in OBS's own config (only while OBS is closed). */
  enableObsWebsocket(): Promise<
    "enabled" | "already-enabled" | "obs-running" | "no-config"
  >;
  /** Start OBS's Virtual Camera over obs-websocket (OBS 28+). */
  startVirtualCamera(): Promise<"started" | "already-on" | "obs-not-connected">;
  /** Stripe payout status from the control plane (cloud mode only; null
   *  in local mode, where there are no payments). Booleans only. */
  payouts(): Promise<{ configured: boolean; started: boolean; enabled: boolean } | null>;
  /** Start/resume Stripe onboarding in the system browser. */
  startPayouts(country: string): Promise<void>;
  /** Mark setup finished and relaunch into the router (picks up saved keys). */
  setupComplete(): Promise<void>;
  /** Fire a test hijack through whichever engine owns money logic. */
  testHijack(prompt: string, durationSec: number): Promise<string>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
}
