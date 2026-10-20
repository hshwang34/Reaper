// OBS control (server-side so the OBS password never reaches a browser page).
// The router's state machine calls POST /api/obs/toggle; this toggles the
// visibility of the Browser Source that displays the AI viewer page. The
// Electron host additionally uses ensureBrowserSource() to auto-provision that
// source so the streamer never opens OBS's UI.
//
// obs-websocket v5: GetSceneItemId → SetSceneItemEnabled. Auth is the built-in
// SHA256 challenge handled by obs-websocket-js when a password is set.

import OBSWebSocket from "obs-websocket-js";
import { log, warn } from "./log.js";
import { CAMERA_INPUT_KINDS, coverTransform, drawnRect, type ObsTransform } from "./obsAlign.js";

export class ObsController {
  private obs = new OBSWebSocket();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private itemCache = new Map<string, number>();
  private connectListeners = new Set<() => void>();

  constructor(
    private url: string,
    private password: string,
  ) {
    this.obs.on("ConnectionClosed", () => {
      this.connected = false;
      this.itemCache.clear();
    });
  }

  /** Run after every successful (re)connect — OBS is often launched, quit,
   *  and relaunched independently of us. Returns an unsubscribe. */
  onConnected(fn: () => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  /** Point at a different server (the wizard just switched obs-websocket on,
   *  and its password is only known now). Drops any live connection so the
   *  next ensureConnected uses the new credentials. */
  reconfigure(url: string, password: string): void {
    if (url === this.url && password === this.password) return;
    this.url = url;
    this.password = password;
    this.itemCache.clear();
    if (this.connected) {
      this.connected = false;
      void this.obs.disconnect().catch(() => {});
    }
    log("obs", `reconfigured → ${url}`);
  }

  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        await this.obs.connect(this.url, this.password || undefined);
        this.connected = true;
        log("obs", `connected ${this.url}`);
        for (const fn of this.connectListeners) fn();
      } catch (e) {
        warn("obs", `connect failed: ${(e as Error).message}`);
        throw e;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private async sceneItemId(scene: string, source: string): Promise<number> {
    const key = `${scene}//${source}`;
    const cached = this.itemCache.get(key);
    if (cached !== undefined) return cached;
    const r = await this.obs.call("GetSceneItemId", {
      sceneName: scene,
      sourceName: source,
    });
    this.itemCache.set(key, r.sceneItemId);
    return r.sceneItemId;
  }

  async setVisible(
    scene: string,
    source: string,
    visible: boolean,
  ): Promise<void> {
    await this.ensureConnected();
    const id = await this.sceneItemId(scene, source);
    // Re-align at the moment it matters: the webcam may have moved since the
    // last hijack. Never let alignment trouble block the unhide itself.
    if (visible) await this.alignToCamera(scene, source).catch((e) => warn("obs", `align failed: ${(e as Error).message}`));
    await this.obs.call("SetSceneItemEnabled", {
      sceneName: scene,
      sceneItemId: id,
      sceneItemEnabled: visible,
    });
    log("obs", `${source} → ${visible ? "VISIBLE" : "hidden"}`);
  }

  /** Snap `source` exactly over the scene's (visible) camera item. No-op when
   *  the scene has no camera, or its geometry can't be reproduced exactly. */
  async alignToCamera(scene: string, source: string): Promise<void> {
    await this.ensureConnected();
    const { sceneItems } = await this.obs.call("GetSceneItemList", { sceneName: scene });
    const cam = sceneItems.find(
      (it) =>
        it.sourceName !== source &&
        it.sceneItemEnabled === true &&
        CAMERA_INPUT_KINDS.has(String(it.inputKind)),
    );
    if (!cam) return;
    const camId = Number(cam.sceneItemId);
    const { sceneItemTransform } = await this.obs.call("GetSceneItemTransform", {
      sceneName: scene,
      sceneItemId: camId,
    });
    const rect = drawnRect(sceneItemTransform as unknown as ObsTransform);
    if (!rect) {
      warn("obs", `"${cam.sourceName}" is rotated/flipped — overlay not auto-aligned`);
      return;
    }
    await this.obs.call("SetSceneItemTransform", {
      sceneName: scene,
      sceneItemId: await this.sceneItemId(scene, source),
      sceneItemTransform: coverTransform(rect),
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Auto-provision the AI overlay Browser Source (the "zero OBS UI" move).
   * Idempotent: creates the source in `scene` if absent, else repairs its URL
   * if it drifted (e.g. the local port moved). The source is always left
   * HIDDEN — go-live visibility is exclusively the buffering gate's decision
   * (frames verified → setVisible(true)), never provisioning's.
   *
   * Settings mirror the hand-setup documented in PHASE0 S4:
   * `shutdown:false` (keep the page alive while hidden — the loopback receiver
   * must stay connected) and `restart_when_active:false` (postmortem bug #4:
   * a reload at go-live destroys the live WebRTC connection).
   */
  async ensureBrowserSource(
    scene: string,
    source: string,
    url: string,
    width = 1920,
    height = 1080,
  ): Promise<"created" | "repaired" | "ok"> {
    await this.ensureConnected();

    const settings = {
      url,
      width,
      height,
      fps: 30,
      shutdown: false,
      restart_when_active: false,
    };

    try {
      await this.sceneItemId(scene, source); // throws when the source is absent
    } catch {
      await this.obs.call("CreateInput", {
        sceneName: scene,
        inputName: source,
        inputKind: "browser_source",
        inputSettings: settings,
        sceneItemEnabled: false, // born hidden — see doc comment
      });
      this.itemCache.clear(); // new item id
      log("obs", `provisioned Browser Source "${source}" → ${url}`);
      return "created";
    }

    // Exists — repair the URL if it drifted; leave visibility untouched.
    const current = await this.obs.call("GetInputSettings", {
      inputName: source,
    });
    const currentUrl = (current.inputSettings as { url?: string }).url;
    if (currentUrl !== url) {
      await this.obs.call("SetInputSettings", {
        inputName: source,
        inputSettings: { url },
      });
      log("obs", `repaired "${source}" url: ${currentUrl} → ${url}`);
      return "repaired";
    }
    return "ok";
  }
}
