// Overlay alignment: put the AI Hijack source exactly over the webcam.
//
// The hijack only reads as "reality changed" if the AI feed lands precisely
// on the webcam's pixels — a few px off and the cut reveals two layers. Doing
// it by hand doesn't survive real use (a stray drag in the OBS canvas moved
// the webcam 3px during testing; a 4:3-era crop + stretch distorted the feed
// 1.33x), so the sidecar re-derives it from the webcam before every unhide.
//
// Pure geometry over obs-websocket's SceneItemTransform, so it's unit-tested
// without OBS. OBS alignment bit flags: LEFT 1, RIGHT 2, TOP 4, BOTTOM 8
// (neither bit on an axis = centered).

export interface ObsTransform {
  positionX: number;
  positionY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  sourceWidth: number;
  sourceHeight: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  alignment: number;
  boundsType: string;
  boundsWidth: number;
  boundsHeight: number;
  boundsAlignment: number;
  cropToBounds?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const LEFT = 1;
const RIGHT = 2;
const TOP = 4;
const BOTTOM = 8;

/** Offset of an alignment point from the top-left of a w×h box. */
function anchor(align: number, w: number, h: number): { dx: number; dy: number } {
  return {
    dx: align & LEFT ? 0 : align & RIGHT ? w : w / 2,
    dy: align & TOP ? 0 : align & BOTTOM ? h : h / 2,
  };
}

/** Where the item's pixels actually land on the canvas, or null when the
 *  geometry isn't one we can reproduce exactly (rotated or flipped items). */
export function drawnRect(t: ObsTransform): Rect | null {
  if (t.rotation % 360 !== 0 || t.scaleX < 0 || t.scaleY < 0) return null;
  const cw = t.sourceWidth - t.cropLeft - t.cropRight;
  const ch = t.sourceHeight - t.cropTop - t.cropBottom;
  if (cw <= 0 || ch <= 0) return null;

  if (t.boundsType === "OBS_BOUNDS_NONE") {
    const w = cw * t.scaleX;
    const h = ch * t.scaleY;
    const a = anchor(t.alignment, w, h);
    return { x: t.positionX - a.dx, y: t.positionY - a.dy, w, h };
  }

  // Bounded: position anchors the bounds box; content is fitted inside it.
  const bw = t.boundsWidth;
  const bh = t.boundsHeight;
  const box = anchor(t.alignment, bw, bh);
  const bx = t.positionX - box.dx;
  const by = t.positionY - box.dy;

  let dw: number;
  let dh: number;
  switch (t.boundsType) {
    case "OBS_BOUNDS_STRETCH":
      [dw, dh] = [bw, bh];
      break;
    case "OBS_BOUNDS_SCALE_OUTER": {
      if (t.cropToBounds) return { x: bx, y: by, w: bw, h: bh };
      const s = Math.max(bw / cw, bh / ch);
      [dw, dh] = [cw * s, ch * s];
      break;
    }
    case "OBS_BOUNDS_SCALE_TO_WIDTH":
      [dw, dh] = [bw, (ch * bw) / cw];
      break;
    case "OBS_BOUNDS_SCALE_TO_HEIGHT":
      [dw, dh] = [(cw * bh) / ch, bh];
      break;
    case "OBS_BOUNDS_MAX_ONLY": {
      const s = Math.min(1, bw / cw, bh / ch);
      [dw, dh] = [cw * s, ch * s];
      break;
    }
    default: {
      // OBS_BOUNDS_SCALE_INNER (letterbox inside the box)
      const s = Math.min(bw / cw, bh / ch);
      [dw, dh] = [cw * s, ch * s];
    }
  }
  // Content sits inside the box per boundsAlignment.
  const inner = anchor(t.boundsAlignment, bw - dw, bh - dh);
  return { x: bx + inner.dx, y: by + inner.dy, w: dw, h: dh };
}

/** The transform that makes an overlay exactly cover `r`: fill the box,
 *  crop the overflow, never stretch. */
export function coverTransform(r: Rect) {
  return {
    positionX: r.x,
    positionY: r.y,
    alignment: LEFT | TOP,
    rotation: 0,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
    boundsType: "OBS_BOUNDS_SCALE_OUTER",
    boundsWidth: r.w,
    boundsHeight: r.h,
    boundsAlignment: 0,
    cropToBounds: true,
  };
}

/** OBS input kinds that are a physical camera, per platform. */
export const CAMERA_INPUT_KINDS: ReadonlySet<string> = new Set([
  "macos-avcapture", // macOS (OBS 30+)
  "av_capture_input", // macOS (legacy)
  "dshow_input", // Windows
  "v4l2_input", // Linux
]);
