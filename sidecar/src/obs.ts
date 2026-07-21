// OBS control (server-side so the OBS password never reaches a browser page).
// The router's state machine calls POST /api/obs/toggle; this toggles the
// visibility of the Browser Source that displays the AI viewer page.
//
// obs-websocket v5: GetSceneItemId → SetSceneItemEnabled. Auth is the built-in
// SHA256 challenge handled by obs-websocket-js when a password is set.

import OBSWebSocket from "obs-websocket-js";
import { env } from "./config.js";
import { log, warn } from "./log.js";

class ObsController {
  private obs = new OBSWebSocket();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private itemCache = new Map<string, number>();

  constructor() {
    this.obs.on("ConnectionClosed", () => {
      this.connected = false;
      this.itemCache.clear();
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        await this.obs.connect(env.obsWsUrl, env.obsWsPassword || undefined);
        this.connected = true;
        log("obs", `connected ${env.obsWsUrl}`);
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
    await this.obs.call("SetSceneItemEnabled", {
      sceneName: scene,
      sceneItemId: id,
      sceneItemEnabled: visible,
    });
    log("obs", `${source} → ${visible ? "VISIBLE" : "hidden"}`);
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export const obs = new ObsController();
