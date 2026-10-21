// OBS control (server-side so the OBS password never reaches a browser page).
// The router's state machine calls POST /api/obs/toggle; this toggles the
// visibility of the Browser Source that displays the AI viewer page. The
// Electron host additionally uses ensureBrowserSource() to auto-provision that
// source so the streamer never opens OBS's UI.
//
// obs-websocket v5: GetSceneItemId → SetSceneItemEnabled. Auth is the built-in
// SHA256 challenge handled by obs-websocket-js when a password is set.
//
// Scene targeting. A configured scene name pins everything to that scene (the
// demo rig's OBS_SCENE). With none — every downloaded app — the overlay is an
// ADDITION to the streamer's own layout: one "AI Hijack" input, placed in
// every scene that shows a webcam, layered directly above that webcam and
// sized to it. Nothing the streamer owns is moved, renamed or re-ordered;
// only our item. Scenes are re-read whenever OBS reports they changed.

import OBSWebSocket from "obs-websocket-js";
import { log, warn } from "./log.js";
import {
  CAMERA_INPUT_KINDS,
  coverTransform,
  drawnRect,
  planOverlay,
  type ObsTransform,
  type OverlayPlacement,
  type SceneSnapshot,
} from "./obsAlign.js";

export type { OverlayPlacement } from "./obsAlign.js";

/** Events after which cached scene items / placements may be stale. */
const LAYOUT_EVENTS = [
  "SceneItemCreated",
  "SceneItemRemoved",
  "SceneCreated",
  "SceneRemoved",
  "SceneNameChanged",
  "InputNameChanged",
  "InputRemoved",
  "CurrentSceneCollectionChanged",
] as const;

export class ObsController {
  private obs = new OBSWebSocket();
  private connected = false;
  private connecting: Promise<void> | null = null;
  private itemCache = new Map<string, number>();
  private connectListeners = new Set<() => void>();
  private layoutListeners = new Set<() => void>();
  /** Where the overlay lives right now (auto mode), for the studio's status
   *  line. Null until the first provision/lookup on this connection. */
  private placements: OverlayPlacement[] | null = null;

  constructor(
    private url: string,
    private password: string,
  ) {
    this.obs.on("ConnectionClosed", () => {
      this.connected = false;
      this.forget();
    });
    // The streamer edits OBS while we're connected: a deleted source, a new
    // scene, a switched collection. Drop what we cached so the next call
    // re-reads instead of failing on a dead item id.
    for (const ev of LAYOUT_EVENTS) {
      this.obs.on(ev, () => {
        this.forget();
        for (const fn of this.layoutListeners) fn();
      });
    }
  }

  private forget(): void {
    this.itemCache.clear();
    this.placements = null;
  }

  /** Run after OBS reports a scene/source layout change. Returns an unsubscribe. */
  onLayoutChanged(fn: () => void): () => void {
    this.layoutListeners.add(fn);
    return () => this.layoutListeners.delete(fn);
  }

  /** Last known placements of the overlay (empty when not installed). */
  overlayPlacements(): OverlayPlacement[] | null {
    return this.placements;
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
    this.forget();
    if (this.connected) {
      this.connected = false;
      void this.obs.disconnect().catch(() => {});
    }
    log("obs", `reconfigured → ${url}`);
  }

  /** Is OBS's Virtual Camera output running? null = OBS not connected, or
   *  an OBS too old to answer (obs-websocket < 5.0 / OBS < 28). */
  async virtualCamActive(): Promise<boolean | null> {
    if (!this.connected) return null;
    try {
      const r = await this.obs.call("GetVirtualCamStatus");
      return r.outputActive;
    } catch {
      return null;
    }
  }

  /** Start the Virtual Camera for the streamer (the wizard's camera step).
   *  Output type (Source vs Program) is OBS's own setting and stays theirs. */
  async startVirtualCam(): Promise<"started" | "already-on" | "obs-not-connected"> {
    await this.ensureConnected().catch(() => {});
    if (!this.connected) return "obs-not-connected";
    const { outputActive } = await this.obs.call("GetVirtualCamStatus");
    if (outputActive) return "already-on";
    await this.obs.call("StartVirtualCam");
    log("obs", "virtual camera started");
    return "started";
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

  /** Read every scene once: items, kinds, transforms of cameras + ours. */
  private async snapshot(source: string): Promise<SceneSnapshot[]> {
    const { scenes } = await this.obs.call("GetSceneList");
    const out: SceneSnapshot[] = [];
    // GetSceneList is top-of-list-first; keep OBS's on-screen order.
    for (const sc of scenes as { sceneName: string }[]) {
      const { sceneItems } = await this.obs.call("GetSceneItemList", { sceneName: sc.sceneName });
      out.push({
        scene: sc.sceneName,
        items: (sceneItems as Record<string, unknown>[]).map((it) => ({
          id: Number(it.sceneItemId),
          index: Number(it.sceneItemIndex),
          name: String(it.sourceName),
          kind: String(it.inputKind ?? ""),
          enabled: it.sceneItemEnabled === true,
          isOurs: it.sourceName === source,
        })),
      });
    }
    return out;
  }

  /** The scenes our overlay is in (and the camera it covers in each). A
   *  configured scene pins it; otherwise it's wherever it was placed. */
  private async resolve(scene: string, source: string): Promise<OverlayPlacement[]> {
    if (scene) {
      const itemId = await this.sceneItemId(scene, source);
      return [{ scene, itemId, camera: null, cameraItemId: null }];
    }
    if (this.placements) return this.placements;
    const snap = await this.snapshot(source);
    this.placements = planOverlay(snap, source, CAMERA_INPUT_KINDS).existing;
    return this.placements;
  }

  async setVisible(
    scene: string,
    source: string,
    visible: boolean,
  ): Promise<void> {
    await this.ensureConnected();
    const where = await this.resolve(scene, source);
    if (!where.length) throw new Error(`"${source}" isn't in any OBS scene — reinstall the overlay`);
    // Every placement, so it's right whichever scene is on air. Hiding must
    // reach all of them even if one scene errors (it may be mid-delete).
    const errors: string[] = [];
    for (const p of where) {
      try {
        // Re-align at the moment it matters: the webcam may have moved since
        // the last hijack. Never let alignment trouble block the unhide.
        if (visible) {
          await this.alignOne(p.scene, source, p.itemId).catch((e) =>
            warn("obs", `align failed in "${p.scene}": ${(e as Error).message}`),
          );
        }
        await this.obs.call("SetSceneItemEnabled", {
          sceneName: p.scene,
          sceneItemId: p.itemId,
          sceneItemEnabled: visible,
        });
      } catch (e) {
        errors.push(`${p.scene}: ${(e as Error).message}`);
      }
    }
    if (errors.length === where.length) {
      this.forget(); // stale ids — the next call re-reads
      throw new Error(errors.join("; "));
    }
    log("obs", `${source} → ${visible ? "VISIBLE" : "hidden"} (${where.map((p) => p.scene).join(", ")})`);
  }

  /** Snap `source` exactly over the (visible) camera in each scene it's in.
   *  No-op where a scene has no camera, or its geometry can't be reproduced. */
  async alignToCamera(scene: string, source: string): Promise<void> {
    await this.ensureConnected();
    for (const p of await this.resolve(scene, source)) {
      await this.alignOne(p.scene, source, p.itemId);
    }
  }

  private async alignOne(scene: string, source: string, itemId: number): Promise<void> {
    const { sceneItems } = await this.obs.call("GetSceneItemList", { sceneName: scene });
    const cam = sceneItems.find(
      (it) =>
        it.sourceName !== source &&
        it.sceneItemEnabled === true &&
        CAMERA_INPUT_KINDS.has(String(it.inputKind)),
    );
    if (!cam) return;
    const { sceneItemTransform } = await this.obs.call("GetSceneItemTransform", {
      sceneName: scene,
      sceneItemId: Number(cam.sceneItemId),
    });
    const rect = drawnRect(sceneItemTransform as unknown as ObsTransform);
    if (!rect) {
      warn("obs", `"${cam.sourceName}" is rotated/flipped — overlay not auto-aligned`);
      return;
    }
    await this.obs.call("SetSceneItemTransform", {
      sceneName: scene,
      sceneItemId: itemId,
      sceneItemTransform: coverTransform(rect),
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Auto-provision the AI overlay Browser Source (the "zero OBS UI" move).
   * Idempotent. Creates the input once, places it (hidden) in the target
   * scene(s), repairs its URL if it drifted (e.g. the local port moved), and
   * aligns it over the webcam. The source is always left HIDDEN — go-live
   * visibility is exclusively the buffering gate's decision (frames verified
   * → setVisible(true)), never provisioning's.
   *
   * Targets: `scene` when configured; otherwise every scene with a webcam,
   * or — when no scene has one — the scene that's on air now.
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
  ): Promise<{ status: "created" | "repaired" | "ok"; placements: OverlayPlacement[] }> {
    await this.ensureConnected();
    this.forget();

    const settings = {
      url,
      width,
      height,
      fps: 30,
      shutdown: false,
      restart_when_active: false,
    };

    const snap = await this.snapshot(source);
    let targets: string[];
    if (scene) {
      if (!snap.some((s) => s.scene === scene)) {
        throw new Error(`OBS has no scene called "${scene}"`);
      }
      targets = [scene];
    } else {
      const plan = planOverlay(snap, source, CAMERA_INPUT_KINDS);
      targets = plan.targets;
      if (!targets.length) {
        const { currentProgramSceneName } = (await this.obs.call("GetCurrentProgramScene")) as {
          currentProgramSceneName: string;
        };
        targets = [currentProgramSceneName];
      }
    }

    // One input, shared by every scene. It may already exist (a scene we
    // don't target, or a previous install) — reuse it, never duplicate it.
    let inputExists = true;
    let currentUrl: string | undefined;
    try {
      const cur = await this.obs.call("GetInputSettings", { inputName: source });
      currentUrl = (cur.inputSettings as { url?: string }).url;
    } catch {
      inputExists = false;
    }

    let status: "created" | "repaired" | "ok" = "ok";
    for (const target of targets) {
      const has = snap.find((s) => s.scene === target)?.items.some((i) => i.isOurs);
      if (has) continue;
      if (!inputExists) {
        await this.obs.call("CreateInput", {
          sceneName: target,
          inputName: source,
          inputKind: "browser_source",
          inputSettings: settings,
          sceneItemEnabled: false, // born hidden — see doc comment
        });
        inputExists = true;
        currentUrl = url;
        log("obs", `provisioned Browser Source "${source}" in "${target}" → ${url}`);
      } else {
        await this.obs.call("CreateSceneItem", {
          sceneName: target,
          sourceName: source,
          sceneItemEnabled: false,
        });
        log("obs", `added "${source}" to scene "${target}"`);
      }
      status = "created";
    }

    if (currentUrl !== url) {
      await this.obs.call("SetInputSettings", { inputName: source, inputSettings: { url } });
      log("obs", `repaired "${source}" url: ${currentUrl} → ${url}`);
      if (status === "ok") status = "repaired";
    }

    // Layer + size: re-read (ids are new), then put ours directly above the
    // webcam wherever it sits BELOW it (a new item lands on top of the whole
    // scene — over the streamer's alerts — and an item under the webcam is
    // invisible). An item the streamer already raised above it stays put.
    const after = planOverlay(await this.snapshot(source), source, CAMERA_INPUT_KINDS);
    for (const p of after.existing) {
      if (p.reorderTo != null) {
        await this.obs.call("SetSceneItemIndex", {
          sceneName: p.scene,
          sceneItemId: p.itemId,
          sceneItemIndex: p.reorderTo,
        });
      }
      await this.alignOne(p.scene, source, p.itemId).catch((e) =>
        warn("obs", `align failed in "${p.scene}": ${(e as Error).message}`),
      );
    }
    this.placements = scene ? after.existing.filter((p) => p.scene === scene) : after.existing;
    return { status, placements: this.placements };
  }
}
