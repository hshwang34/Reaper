// The opening demo's player: one recorded stream clip plus one real lucy-2.5 render of it
// per effect. Every clip has the same frame count (site/tools/encode-hero.sh), so picking an
// effect jumps to that render AT THE SAME MOMENT: the person keeps talking mid-sentence and
// only the effect changes.
//
// How the switch stays instant and never shows black:
// - The base <video> is the master clock and always plays.
// - Two effect <video>s double-buffer. A new effect loads into the hidden one, seeks to the
//   base's time, and becomes visible the moment that frame is decoded; the old picture
//   stays up until then.
// - On desktop, clips are prefetched into memory as Blobs (two at a time, hovered/focused
//   buttons first), so a seek is a local decode. Phones and slow links get the 360p set and
//   stream each clip only when it is picked. Keyframes every 0.5 s keep a seek's decode short.
// - While an effect is up, a per-frame check nudges its playbackRate (small drift) or re-seeks
//   it (big drift) so it stays locked to the base, across loop wrap-arounds too.
// - Nothing decodes while the player is off screen or the tab is hidden.

export interface HeroClip {
  id: string;
  emoji: string;
  label: string;
  description: string;
  hd: string;
  sd: string;
  poster: string;
}

export interface HeroManifest {
  model: string;
  fps: number;
  frames: number;
  duration: number;
  clips: HeroClip[];
}

export const BASE_ID = "base";
const HARD_DRIFT = 0.25; // seconds: re-seek
const SOFT_DRIFT = 0.035; // seconds: nudge the rate
const PREFETCH_CONCURRENCY = 2;
const SEEK_LEAD = 0.03; // seconds a fresh seek lands ahead of the base

export async function loadHeroManifest(): Promise<HeroManifest | null> {
  try {
    const res = await fetch("/clips/hero/manifest.json", { cache: "no-cache" });
    if (!res.ok) return null;
    const m = (await res.json()) as HeroManifest;
    return m.clips?.some((c) => c.id === BASE_ID) ? m : null;
  } catch {
    return null;
  }
}

/** Phones and slow or data-saving connections get the 360p set and no background prefetch. */
function liteMode(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return (
    window.matchMedia("(max-width: 720px)").matches ||
    !!c?.saveData ||
    /(^|-)(2g|3g)$/.test(c?.effectiveType ?? "")
  );
}

function makeVideo(cls: string): HTMLVideoElement {
  const v = document.createElement("video");
  v.className = `clip ${cls}`;
  // muted must be set as a property before play() for autoplay to be allowed
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.loop = true;
  v.preload = "auto";
  v.disableRemotePlayback = true;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("aria-hidden", "true");
  return v;
}

const once = (el: EventTarget, ev: string, ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    el.addEventListener(ev, () => (clearTimeout(t), resolve()), { once: true });
  });

export interface HeroPlayerOptions {
  /** Called once the picture actually shows `id` (null = the original stream). */
  onShow?: (id: string | null) => void;
  /** Called when the browser refused to autoplay (e.g. Low Power Mode); a click on play fixes it. */
  onBlocked?: () => void;
  /** Start paused on posters (prefers-reduced-motion). */
  still?: boolean;
}

export class HeroPlayer {
  private readonly clips: Map<string, HeroClip>;
  private readonly order: string[];
  private readonly base: HTMLVideoElement;
  private readonly layers: [HTMLVideoElement, HTMLVideoElement];
  private front = -1; // index of the visible effect layer, -1 = original stream
  private active: string | null = null;
  private seq = 0;
  private lite = liteMode();
  private blobs = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  private queue: string[] = [];
  private prefetching = false;
  private onScreen = false;
  private playing: boolean;

  constructor(
    private readonly frame: HTMLElement,
    private readonly manifest: HeroManifest,
    private readonly opts: HeroPlayerOptions = {},
  ) {
    this.clips = new Map(manifest.clips.map((c) => [c.id, c]));
    this.order = manifest.clips.map((c) => c.id).filter((id) => id !== BASE_ID);
    this.playing = !opts.still;

    const base = this.clips.get(BASE_ID)!;
    this.base = makeVideo("hero-base");
    this.base.poster = base.poster;
    this.layers = [makeVideo("hero-fx"), makeVideo("hero-fx")];
    // effect layers fetch nothing until chosen
    for (const l of this.layers) l.preload = "none";
    frame.prepend(this.base, ...this.layers);
    frame.dataset.source = "clips";
    if (this.playing) this.base.src = this.url(base);

    // Prefetch once the original stream can play through, so it never competes with it.
    this.base.addEventListener("canplaythrough", () => this.startPrefetch(), { once: true });

    new IntersectionObserver(
      ([e]) => {
        this.onScreen = !!e?.isIntersecting;
        this.apply();
      },
      { threshold: 0.15 },
    ).observe(frame);
    document.addEventListener("visibilitychange", () => this.apply());
    this.syncLoop();
  }

  get current(): string | null {
    return this.active;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  effects(): HeroClip[] {
    return this.order.map((id) => this.clips.get(id)!);
  }

  clip(id: string): HeroClip | undefined {
    return this.clips.get(id);
  }

  /** Move a clip to the front of the prefetch queue (hover, focus, touch). */
  warm(id: string): void {
    // phones/slow links stream on demand: a blob fetch racing the <video> would download twice
    if (this.lite || id === BASE_ID || !this.clips.has(id)) return;
    void this.prefetch(id);
  }

  setPlaying(on: boolean): void {
    this.playing = on;
    if (on) {
      const base = this.clips.get(BASE_ID)!;
      if (!this.base.getAttribute("src")) this.base.src = this.url(base);
      // a still frame shown with no src: give it its video now
      const l = this.front >= 0 ? this.layers[this.front]! : null;
      if (l && this.active && !l.getAttribute("src")) {
        l.src = this.url(this.clips.get(this.active)!);
        l.currentTime = this.target();
      }
    }
    this.apply();
  }

  /** Show an effect (or the original stream for null / "base") at the current moment. */
  async show(id: string | null): Promise<void> {
    if (id === BASE_ID) id = null;
    const my = ++this.seq;
    if (id === this.active) return;

    if (id === null) {
      this.reveal(-1);
      this.active = null;
      this.opts.onShow?.(null);
      return;
    }
    const clip = this.clips.get(id);
    if (!clip) return;
    this.warm(id);

    const backIdx = this.front === 0 ? 1 : 0;
    const back = this.layers[backIdx]!;
    back.poster = clip.poster;

    if (!this.playing) {
      // reduced motion / paused: show the effect's still, no decoding
      back.pause();
      back.removeAttribute("src");
      back.load();
      this.reveal(backIdx);
      this.active = id;
      this.opts.onShow?.(id);
      return;
    }

    const src = this.url(clip);
    if (back.dataset.id !== id || back.getAttribute("src") !== src) {
      back.dataset.id = id;
      back.preload = "auto";
      back.src = src;
    }
    if (back.readyState < HTMLMediaElement.HAVE_METADATA) await once(back, "loadedmetadata", 4000);
    if (my !== this.seq) return;

    // Seek a hair ahead of the base (the seek itself takes a few ms), then show the decoded
    // frame the moment it is ready and start playback behind it; the sync loop absorbs the
    // remaining few milliseconds. Waiting for play() first would add a frame or two.
    back.playbackRate = 1;
    back.currentTime = (this.target() + SEEK_LEAD) % (this.manifest.duration || 1);
    await once(back, "seeked", 1500);
    if (my !== this.seq) return;

    this.reveal(backIdx);
    this.active = id;
    void back.play().catch(() => {});
    this.opts.onShow?.(id);
  }

  /* ---------- internals ---------- */

  private url(c: HeroClip): string {
    return this.blobs.get(c.id) ?? (this.lite ? c.sd : c.hd);
  }

  private reveal(idx: number): void {
    const prev = this.front;
    this.front = idx;
    this.layers.forEach((l, i) => l.classList.toggle("on", i === idx));
    this.frame.dataset.fx = idx >= 0 ? "on" : "off";
    if (prev >= 0 && prev !== idx) {
      const old = this.layers[prev]!;
      // pause after the new picture is up, so there is never a gap
      requestAnimationFrame(() => {
        if (this.front !== prev) old.pause();
      });
    }
  }

  /** Where every clip should be: the base clip's time. */
  private target(): number {
    return this.base.currentTime % (this.manifest.duration || this.base.duration || 1);
  }

  /** Signed shortest distance (effect − base), wrapping around the loop point. */
  private drift(v: HTMLVideoElement): number {
    const dur = this.manifest.duration || 1;
    let d = (v.currentTime - this.target()) % dur;
    if (d > dur / 2) d -= dur;
    if (d < -dur / 2) d += dur;
    return d;
  }

  private apply(): void {
    const run = this.playing && this.onScreen && !document.hidden;
    const fx = this.front >= 0 ? this.layers[this.front]! : null;
    if (run) {
      this.base.play().catch(() => this.blocked());
      if (fx?.getAttribute("src")) {
        fx.currentTime = this.target();
        fx.play().catch(() => {});
      }
    } else {
      this.base.pause();
      fx?.pause();
    }
  }

  private blocked(): void {
    if (!this.playing) return;
    this.playing = false;
    this.opts.onBlocked?.();
  }

  private syncLoop(): void {
    const step = () => {
      const fx = this.front >= 0 ? this.layers[this.front]! : null;
      if (fx && !fx.paused && !fx.seeking && !this.base.paused && !this.base.seeking) {
        const d = this.drift(fx);
        if (Math.abs(d) > HARD_DRIFT) {
          fx.playbackRate = 1;
          fx.currentTime = this.target();
        } else if (Math.abs(d) > SOFT_DRIFT) {
          fx.playbackRate = d > 0 ? 0.96 : 1.04;
        } else if (fx.playbackRate !== 1) {
          fx.playbackRate = 1;
        }
      }
    };
    if (typeof this.base.requestVideoFrameCallback === "function") {
      const tick = () => {
        step();
        this.base.requestVideoFrameCallback(tick);
      };
      this.base.requestVideoFrameCallback(tick);
      // rVFC stops while the base is paused; a slow timer covers resumes
      setInterval(step, 500);
    } else {
      setInterval(step, 120);
    }
  }

  private startPrefetch(): void {
    if (this.lite || !this.playing) return; // phones/slow links: stream only what's picked
    this.queue = [...this.order];
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.prefetching) return;
    this.prefetching = true;
    const worker = async () => {
      for (let id = this.queue.shift(); id; id = this.queue.shift()) await this.prefetch(id);
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    this.prefetching = false;
  }

  private prefetch(id: string): Promise<void> {
    if (this.blobs.has(id)) return Promise.resolve();
    const running = this.inflight.get(id);
    if (running) return running;
    this.queue = this.queue.filter((q) => q !== id);
    const clip = this.clips.get(id)!;
    const p = fetch(this.lite ? clip.sd : clip.hd)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        this.blobs.set(id, URL.createObjectURL(b));
      })
      .catch(() => {
        /* the network URL still works; the switch is just a little slower */
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }
}
