// The output guard (docs/CONTENT-SAFETY.md S4): an in-browser NSFW classifier
// sampling the MODEL'S OUTPUT on the streamer's machine. A benign prompt can
// still render something a platform bans, and on stream that is the
// streamer's violation — so the last check runs on the pixels, not the text.
//
//   · before LIVE: one frame must pass before OBS is unhidden (the machine
//     calls check() inside the buffering gate — a positive aborts the job and
//     the source is never shown)
//   · during LIVE: ~2 fps sampling; K consecutive positives → teardown, which
//     hides OBS first, exactly like panic
//
// nsfwjs MobileNetV2 (~3.4 MB, bundled — no network fetch), TF.js on WebGL.
// Loaded lazily on first use so the router page doesn't pay for it when the
// guard is off. Accuracy on STYLIZED video is unverified (anime/horror
// presets!) — thresholds are deliberately conservative and the guard logs
// every score so the alpha can measure false positives (CONTENT-SAFETY §9).

import type { GuardPort, GuardVerdict } from "./ports.js";

/** Classes from the nsfwjs model: Drawing, Hentai, Neutral, Porn, Sexy. */
type Pred = { className: string; probability: number };
interface Classifier {
  classify(img: HTMLCanvasElement, topk?: number): Promise<Pred[]>;
}

/** Explicit classes summed; "Hentai" matters because several presets are
 *  drawn styles where explicit output would be classed as illustration. */
const EXPLICIT_THRESHOLD = 0.6;
/** "Sexy" alone is noisy (swimwear, tight framing) — only a very confident
 *  score counts. */
const SUGGESTIVE_THRESHOLD = 0.85;
const SAMPLE_MS = 500;
const CONSECUTIVE = 2;
const SIZE = 224;

export function verdictFrom(preds: Pred[]): GuardVerdict {
  const p = (name: string) => preds.find((x) => x.className === name)?.probability ?? 0;
  const explicit = p("Porn") + p("Hentai");
  const sexy = p("Sexy");
  if (explicit >= EXPLICIT_THRESHOLD) {
    return { unsafe: true, label: p("Porn") >= p("Hentai") ? "Porn" : "Hentai", score: explicit };
  }
  if (sexy >= SUGGESTIVE_THRESHOLD) return { unsafe: true, label: "Sexy", score: sexy };
  return { unsafe: false, label: "ok", score: Math.max(explicit, sexy) };
}

export class FrameGuard implements GuardPort {
  private model: Promise<Classifier | null> | null = null;
  private canvas: HTMLCanvasElement | null = null;

  constructor(private log: (line: string) => void = () => {}) {}

  ready(): Promise<boolean> {
    this.model ??= this.load();
    return this.model.then((m) => m !== null);
  }

  private async load(): Promise<Classifier | null> {
    try {
      // nsfwjs decodes its bundled weights with Node's Buffer.
      const { Buffer } = await import("buffer");
      (globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
      await import("@tensorflow/tfjs");
      const [{ load }, { MobileNetV2Model }] = await Promise.all([
        import("nsfwjs/core"),
        import("nsfwjs/models/mobilenet_v2"),
      ]);
      const model = (await load("MobileNetV2", {
        modelDefinitions: [MobileNetV2Model],
      })) as unknown as Classifier;
      this.log("output guard ready (nsfwjs MobileNetV2)");
      return model;
    } catch (e) {
      this.log(`output guard unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  async check(stream: MediaStream): Promise<GuardVerdict> {
    const model = await this.model;
    if (!model) return { unsafe: false, label: "unavailable", score: 0 };
    const video = await this.attach(stream);
    try {
      return await this.classify(model, video);
    } finally {
      video.srcObject = null;
    }
  }

  watch(stream: MediaStream, onUnsafe: (v: GuardVerdict) => void): () => void {
    let stopped = false;
    let hits = 0;
    let video: HTMLVideoElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      const model = await this.model;
      if (!model || stopped) return;
      try {
        video ??= await this.attach(stream);
        const v = await this.classify(model, video);
        if (stopped) return;
        hits = v.unsafe ? hits + 1 : 0;
        if (v.unsafe) this.log(`output guard: ${v.label} ${v.score.toFixed(2)} (${hits}/${CONSECUTIVE})`);
        if (hits >= CONSECUTIVE) {
          stopped = true;
          onUnsafe(v);
          return;
        }
      } catch {
        /* a dropped frame isn't a verdict */
      }
      timer = setTimeout(() => void tick(), SAMPLE_MS);
    };
    timer = setTimeout(() => void tick(), SAMPLE_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
      if (video) video.srcObject = null;
    };
  }

  private async attach(stream: MediaStream): Promise<HTMLVideoElement> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (video.readyState < 2) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.addEventListener("loadeddata", done, { once: true });
        setTimeout(done, 1_000);
      });
    }
    return video;
  }

  private async classify(model: Classifier, video: HTMLVideoElement): Promise<GuardVerdict> {
    this.canvas ??= Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(video, 0, 0, SIZE, SIZE);
    return verdictFrom(await model.classify(this.canvas, 5));
  }
}
