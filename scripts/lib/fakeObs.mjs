// A small stateful obs-websocket v5 server for the e2e scripts: scenes with
// layered items, inputs, and just enough of the request surface the sidecar
// uses (provisioning, alignment, show/hide). It records what the audience
// would see — every SetSceneItemEnabled on our overlay — so tests assert on
// OBS, not on our own logs.
//
//   const obs = startFakeObs(port, { scenes: { "Just Chatting": [webcam()] } });
//   obs.visibility   // [{ visible, scene, at }] — overlay show/hide, in order
//   obs.provisionedUrl()
//   obs.scene("Just Chatting") // bottom → top item names

import { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";

export const OVERLAY = "AI Hijack";

/** A 16:9 webcam letterboxed into a box, like a real streamer layout. */
export const webcam = (name = "Webcam", kind = "macos-avcapture") => ({
  name,
  kind,
  enabled: true,
  transform: {
    positionX: 398, positionY: 180, rotation: 0, scaleX: 1, scaleY: 1,
    sourceWidth: 1920, sourceHeight: 1080,
    cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
    alignment: 5, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1104, boundsHeight: 623, boundsAlignment: 0,
    cropToBounds: false,
  },
});
export const layer = (name, kind = "image_source") => ({ name, kind, enabled: true });

export function startFakeObs(port, { scenes = { Scene: [webcam()] }, program, overlayIn = [] } = {}) {
  let nextId = 1;
  /** scene name → items bottom → top: { id, name, kind, enabled, transform } */
  const state = new Map();
  /** input name → { kind, settings } */
  const inputs = new Map();
  for (const [scene, items] of Object.entries(scenes)) {
    state.set(scene, items.map((it) => ({ id: nextId++, enabled: true, transform: {}, ...it })));
    for (const it of items) inputs.set(it.name, { kind: it.kind, settings: {} });
  }
  // Pre-installed overlay (the demo rig's hand setup).
  for (const scene of overlayIn) {
    inputs.set(OVERLAY, { kind: "browser_source", settings: { url: "" } });
    state.get(scene).push({ id: nextId++, name: OVERLAY, kind: "browser_source", enabled: false, transform: {} });
  }
  const programScene = program ?? Object.keys(scenes)[0];
  const visibility = [];
  let provisionedUrl = "";
  const sockets = new Set();

  const fail = (code, comment) => ({ fail: { result: false, code, comment } });
  const items = (scene) => state.get(scene) ?? null;

  function handle(type, d) {
    switch (type) {
      case "GetVersion":
        return { obsWebSocketVersion: "5.5.0" };
      case "GetVideoSettings":
        return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 };
      case "GetSceneList":
        // obs-websocket lists scenes top-of-list first; order isn't relied on.
        return { currentProgramSceneName: programScene, scenes: [...state.keys()].map((sceneName, i) => ({ sceneName, sceneIndex: i })) };
      case "GetCurrentProgramScene":
        return { currentProgramSceneName: programScene, sceneName: programScene };
      case "GetSceneItemList": {
        const list = items(d.sceneName);
        if (!list) return fail(600, `No scene "${d.sceneName}"`);
        return {
          sceneItems: list.map((it, index) => ({
            sceneItemId: it.id,
            sceneItemIndex: index,
            sourceName: it.name,
            inputKind: it.kind,
            sceneItemEnabled: it.enabled,
            sceneItemTransform: it.transform,
          })),
        };
      }
      case "GetSceneItemId": {
        const it = items(d.sceneName)?.find((x) => x.name === d.sourceName);
        return it ? { sceneItemId: it.id } : fail(600, "No scene items were found");
      }
      case "GetSceneItemTransform": {
        const it = items(d.sceneName)?.find((x) => x.id === d.sceneItemId);
        return it ? { sceneItemTransform: it.transform } : fail(600, "No such item");
      }
      case "SetSceneItemTransform": {
        const it = items(d.sceneName)?.find((x) => x.id === d.sceneItemId);
        if (!it) return fail(600, "No such item");
        it.transform = { ...it.transform, ...d.sceneItemTransform };
        return {};
      }
      case "SetSceneItemEnabled": {
        const it = items(d.sceneName)?.find((x) => x.id === d.sceneItemId);
        if (!it) return fail(600, "No such item");
        it.enabled = d.sceneItemEnabled;
        if (it.name === OVERLAY) visibility.push({ visible: d.sceneItemEnabled, scene: d.sceneName, at: Date.now() });
        return {};
      }
      case "SetSceneItemIndex": {
        const list = items(d.sceneName);
        const i = list?.findIndex((x) => x.id === d.sceneItemId) ?? -1;
        if (i < 0) return fail(600, "No such item");
        const [it] = list.splice(i, 1);
        list.splice(d.sceneItemIndex, 0, it);
        return {};
      }
      case "GetInputSettings": {
        const inp = inputs.get(d.inputName);
        return inp ? { inputKind: inp.kind, inputSettings: inp.settings } : fail(600, "No source was found");
      }
      case "SetInputSettings": {
        const inp = inputs.get(d.inputName);
        if (!inp) return fail(600, "No source was found");
        inp.settings = { ...inp.settings, ...d.inputSettings };
        if (d.inputName === OVERLAY) provisionedUrl = inp.settings.url ?? provisionedUrl;
        return {};
      }
      case "CreateInput": {
        const list = items(d.sceneName);
        if (!list) return fail(600, `No scene "${d.sceneName}"`);
        if (inputs.has(d.inputName)) return fail(601, "A source already exists by that input name");
        inputs.set(d.inputName, { kind: d.inputKind, settings: d.inputSettings ?? {} });
        const it = { id: nextId++, name: d.inputName, kind: d.inputKind, enabled: d.sceneItemEnabled !== false, transform: {} };
        list.push(it);
        if (d.inputName === OVERLAY) provisionedUrl = d.inputSettings?.url ?? provisionedUrl;
        emit("SceneItemCreated", { sceneName: d.sceneName, sourceName: d.inputName, sceneItemId: it.id });
        return { inputUuid: `uuid-${it.id}`, sceneItemId: it.id };
      }
      case "CreateSceneItem": {
        const list = items(d.sceneName);
        const inp = inputs.get(d.sourceName);
        if (!list || !inp) return fail(600, "No such scene or source");
        const it = { id: nextId++, name: d.sourceName, kind: inp.kind, enabled: d.sceneItemEnabled !== false, transform: {} };
        list.push(it);
        emit("SceneItemCreated", { sceneName: d.sceneName, sourceName: d.sourceName, sceneItemId: it.id });
        return { sceneItemId: it.id };
      }
      default:
        return {};
    }
  }

  function emit(eventType, eventData) {
    for (const s of sockets) s.send({ op: 5, d: { eventType, eventIntent: 1, eventData } });
  }

  const wss = new WebSocketServer({
    port,
    host: "127.0.0.1",
    handleProtocols: (p) => (p.has("obswebsocket.msgpack") ? "obswebsocket.msgpack" : "obswebsocket.json"),
  });
  wss.on("connection", (ws) => {
    const msgpack = ws.protocol === "obswebsocket.msgpack";
    const sock = { send: (m) => ws.readyState === 1 && ws.send(msgpack ? encode(m) : JSON.stringify(m)) };
    sock.send({ op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } });
    ws.on("message", (raw, isBinary) => {
      const m = isBinary ? decode(raw) : JSON.parse(String(raw));
      if (m.op === 1) {
        sockets.add(sock);
        return sock.send({ op: 2, d: { negotiatedRpcVersion: 1 } });
      }
      if (m.op !== 6) return;
      const { requestType, requestId, requestData = {} } = m.d;
      const out = handle(requestType, requestData);
      const status = out?.fail ?? { result: true, code: 100 };
      sock.send({ op: 7, d: { requestType, requestId, requestStatus: status, responseData: out?.fail ? undefined : out } });
    });
    ws.on("close", () => sockets.delete(sock));
  });

  return {
    wss,
    visibility,
    provisionedUrl: () => provisionedUrl,
    /** Item names in a scene, bottom → top. */
    scene: (name) => (state.get(name) ?? []).map((it) => it.name),
    item: (sceneName, name) => (state.get(sceneName) ?? []).find((it) => it.name === name) ?? null,
    close: () => wss.close(),
  };
}
