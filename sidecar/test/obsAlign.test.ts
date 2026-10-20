// Overlay geometry: the AI Hijack source must land exactly on the webcam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coverTransform, drawnRect, type ObsTransform } from "../src/obsAlign.js";

const base: ObsTransform = {
  positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1,
  sourceWidth: 1920, sourceHeight: 1080,
  cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
  alignment: 5, boundsType: "OBS_BOUNDS_NONE", boundsWidth: 0, boundsHeight: 0, boundsAlignment: 0,
};

test("unbounded, top-left aligned: scaled source size at the position", () => {
  assert.deepEqual(drawnRect({ ...base, positionX: 10, positionY: 20, scaleX: 0.5, scaleY: 0.5 }), {
    x: 10, y: 20, w: 960, h: 540,
  });
});

test("unbounded, centered: position is the box center; crop shrinks content", () => {
  const r = drawnRect({ ...base, alignment: 0, positionX: 960, positionY: 540, cropLeft: 160, cropRight: 160 });
  assert.deepEqual(r, { x: 160, y: 0, w: 1600, h: 1080 });
});

test("the measured rig: 16:9 webcam letterboxed (SCALE_INNER) in a 1104×623 box", () => {
  const r = drawnRect({
    ...base, positionX: 396, positionY: 116,
    boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1104, boundsHeight: 623,
  })!;
  assert.equal(r.x, 396);
  assert.equal(r.w, 1104);
  assert.ok(Math.abs(r.h - 621) < 0.01); // 1104 × 9/16
  assert.ok(Math.abs(r.y - 117) < 0.01); // centered: 1px letterbox top + bottom
});

test("4:3 camera in a 16:9 box (SCALE_INNER): overlay covers only the pillarboxed pixels", () => {
  const r = drawnRect({
    ...base, sourceWidth: 640, sourceHeight: 480,
    boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1600, boundsHeight: 900,
  })!;
  assert.deepEqual(r, { x: 200, y: 0, w: 1200, h: 900 });
});

test("stretch and crop-to-bounds fill the box exactly", () => {
  const bounded = { ...base, boundsWidth: 800, boundsHeight: 600, positionX: 5, positionY: 7 };
  assert.deepEqual(drawnRect({ ...bounded, boundsType: "OBS_BOUNDS_STRETCH" }), { x: 5, y: 7, w: 800, h: 600 });
  assert.deepEqual(drawnRect({ ...bounded, boundsType: "OBS_BOUNDS_SCALE_OUTER", cropToBounds: true }), {
    x: 5, y: 7, w: 800, h: 600,
  });
});

test("rotated or flipped cameras are refused rather than guessed", () => {
  assert.equal(drawnRect({ ...base, rotation: 90 }), null);
  assert.equal(drawnRect({ ...base, scaleX: -1 }), null);
});

test("coverTransform: top-left anchored, fills + crops, never stretches", () => {
  const t = coverTransform({ x: 1, y: 2, w: 3, h: 4 });
  assert.equal(t.boundsType, "OBS_BOUNDS_SCALE_OUTER");
  assert.equal(t.cropToBounds, true);
  assert.equal(t.alignment, 5);
  assert.deepEqual([t.positionX, t.positionY, t.boundsWidth, t.boundsHeight], [1, 2, 3, 4]);
});

// ── planOverlay: which scenes, which layer ─────────────────────────────────
import { CAMERA_INPUT_KINDS, planOverlay, type SceneSnapshot } from "../src/obsAlign.js";

const item = (id: number, index: number, name: string, kind: string, extra: Partial<SceneSnapshot["items"][0]> = {}) => ({
  id, index, name, kind, enabled: true, isOurs: name === "AI Hijack", ...extra,
});

test("targets every scene with a visible webcam — never a hardcoded 'Scene'", () => {
  const scenes: SceneSnapshot[] = [
    { scene: "Starting Soon", items: [item(1, 0, "Countdown", "ffmpeg_source")] },
    { scene: "Just Chatting", items: [item(2, 0, "BG", "image_source"), item(3, 1, "Facecam", "macos-avcapture")] },
    { scene: "Gaming", items: [item(4, 0, "Game", "game_capture"), item(5, 1, "Cam", "dshow_input")] },
    { scene: "BRB", items: [item(6, 0, "Facecam", "macos-avcapture", { enabled: false })] },
  ];
  const { targets, existing } = planOverlay(scenes, "AI Hijack", CAMERA_INPUT_KINDS);
  assert.deepEqual(targets, ["Just Chatting", "Gaming"]);
  assert.deepEqual(existing, []);
});

test("a fresh install (on top of everything) moves directly above the webcam, under the streamer's frame + alerts", () => {
  // bottom → top: BG, Facecam, Cam frame, Alerts, AI Hijack (just created)
  const scenes: SceneSnapshot[] = [{
    scene: "Just Chatting",
    items: [
      item(1, 0, "BG", "image_source"),
      item(2, 1, "Facecam", "macos-avcapture"),
      item(3, 2, "Cam frame", "image_source"),
      item(4, 3, "Alerts", "browser_source"),
      item(9, 4, "AI Hijack", "browser_source"),
    ],
  }];
  const [p] = planOverlay(scenes, "AI Hijack", CAMERA_INPUT_KINDS).existing;
  assert.equal(p!.camera, "Facecam");
  assert.equal(p!.reorderTo, 2); // → BG, Facecam, AI Hijack, Cam frame, Alerts
});

test("an overlay below the webcam (invisible) is raised to just above it; one already there stays put", () => {
  const below: SceneSnapshot[] = [{
    scene: "S",
    items: [item(9, 0, "AI Hijack", "browser_source"), item(1, 1, "BG", "image_source"), item(2, 2, "Cam", "macos-avcapture")],
  }];
  assert.equal(planOverlay(below, "AI Hijack", CAMERA_INPUT_KINDS).existing[0]!.reorderTo, 2);
  const ok: SceneSnapshot[] = [{
    scene: "S",
    items: [item(2, 0, "Cam", "macos-avcapture"), item(9, 1, "AI Hijack", "browser_source"), item(3, 2, "Alerts", "browser_source")],
  }];
  assert.equal(planOverlay(ok, "AI Hijack", CAMERA_INPUT_KINDS).existing[0]!.reorderTo, null);
});

test("a scene with no webcam keeps the overlay where it is", () => {
  const scenes: SceneSnapshot[] = [{ scene: "Scene", items: [item(9, 0, "AI Hijack", "browser_source")] }];
  const { targets, existing } = planOverlay(scenes, "AI Hijack", CAMERA_INPUT_KINDS);
  assert.deepEqual(targets, []);
  assert.deepEqual(existing, [{ scene: "Scene", itemId: 9, camera: null, cameraItemId: null, reorderTo: null }]);
});
