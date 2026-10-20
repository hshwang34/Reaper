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
  /** The hosted control plane, or null when none is configured — then the
   *  wizard offers local mode only (no Twitch sign-in button to fail). */
  cloudUrl: string | null;
  obs: { discovery: string; connected: boolean; running: boolean };
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
  /** Mark setup finished and relaunch into the router (picks up saved keys). */
  setupComplete(): Promise<void>;
  /** Fire a test hijack through whichever engine owns money logic. */
  testHijack(prompt: string, durationSec: number): Promise<string>;
  setAutoLaunch(enabled: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
}
