// Reality Hijack marketing site — the script the page needs, and no more.
//
// The hero "monitor" replays the product's own loop at copy level:
//   raw feed → tip → 400 ms static → hijacked feed for $N = N s → static → raw.
// With recorded clips (public/clips/manifest.json) the layers show the real
// model output and the real camera; without them the raw feed is a standby
// slate and the hijacked feed is a CSS look with a channel ident. Nothing
// here ever calls the model.

import "./style.css";

/* ---------- data ---------- */

interface Cycle {
  who: string;
  amount: number;
  preset: string;
  ch: string;
  label: string;
}

// Fixed order and amounts, so the replay is reproducible for screenshots.
const CYCLES: Cycle[] = [
  { who: "quartz_ok", amount: 11, preset: "lava-room", ch: "CH 01", label: "Lava Room" },
  { who: "mossy_pond", amount: 6, preset: "underwater", ch: "CH 02", label: "Underwater" },
  { who: "vhs_ghost", amount: 8, preset: "80s-anime", ch: "CH 03", label: "80s Anime" },
  { who: "neon_rat", amount: 7, preset: "cyberpunk", ch: "CH 04", label: "Cyberpunk City" },
  { who: "cellar_door", amount: 9, preset: "haunted", ch: "CH 05", label: "Haunted" },
  { who: "snowdayyy", amount: 5, preset: "winter-wonderland", ch: "CH 06", label: "Winter Wonderland" },
];

interface ClipEntry {
  preset: string;
  /** The model's output. Required. */
  after: string;
  /** Raw camera, time-aligned with `after`. Optional. */
  before?: string;
  poster?: string;
}
interface Manifest {
  clips: ClipEntry[];
}

const RAW_MS = 1600;
const TIP_MS = 800;
const WIPE_MS = 400;
const RETURN_MS = 500;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- helpers ---------- */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadManifest(): Promise<Map<string, ClipEntry>> {
  const map = new Map<string, ClipEntry>();
  try {
    const res = await fetch("/clips/manifest.json", { cache: "no-cache" });
    if (!res.ok) return map;
    const m = (await res.json()) as Manifest;
    for (const c of m.clips ?? []) if (c.after) map.set(c.preset, c);
  } catch {
    /* no clips */
  }
  return map;
}

/* ---------- the monitor ---------- */

class Monitor {
  private screen = $("screen");
  private rawLayer = $("rawLayer");
  private rawVideo = $<HTMLVideoElement>("rawVideo");
  private feed = $("feed");
  private feedVideo = $<HTMLVideoElement>("feedVideo");
  private pipVideo = $<HTMLVideoElement>("pipVideo");
  private identCh = $("identCh");
  private identName = $("identName");
  private wipe = $("wipe");
  private hudState = $("hudState");
  private hudTip = $("hudTip");
  private hudCount = $("hudCount");
  private hudBar = $("hudBar");
  private pauseBtn = $<HTMLButtonElement>("demoPause");
  private note = $("demoNote");
  private source = $("demoSource");

  private clips = new Map<string, ClipEntry>();
  private i = 0;
  private gen = 0;
  private paused = REDUCED;
  private skip: (() => void) | null = null;

  constructor() {
    this.screen.addEventListener("click", () => this.next());
    this.screen.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.next();
      }
    });
    this.pauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.paused ? this.play() : this.pause();
    });
    this.syncPauseButton();
  }

  setClips(clips: Map<string, ClipEntry>): void {
    this.clips = clips;
    if (clips.size > 0) {
      this.source.textContent = "Real output from the model, recorded on the rig.";
      const first = CYCLES.findIndex((c) => clips.has(c.preset));
      if (first > 0) this.i = first;
    }
    if (REDUCED) this.note.textContent = "Replay of the loop. Press play, or activate the screen to run one hijack.";
  }

  start(): void {
    this.showRaw();
    if (!REDUCED) void this.loop();
  }

  /** Public: jump to the next tip (also wired to the "Watch a hijack" button). */
  next(): void {
    if (this.paused) {
      void this.runOne(++this.gen);
      return;
    }
    this.skip?.();
  }

  private play(): void {
    this.paused = false;
    this.syncPauseButton();
    void this.loop();
  }

  private pause(): void {
    this.paused = true;
    this.syncPauseButton();
    this.gen++;
    this.skip = null;
    this.showRaw();
  }

  private syncPauseButton(): void {
    this.pauseBtn.textContent = this.paused ? "play" : "pause";
    this.pauseBtn.setAttribute("aria-label", this.paused ? "Play the replay" : "Pause the replay");
  }

  private async loop(): Promise<void> {
    const gen = ++this.gen;
    while (!this.paused && gen === this.gen) {
      await this.runOne(gen);
      if (gen !== this.gen) return;
      await this.wait(RAW_MS, gen);
    }
  }

  /** Wait, but let a click cut it short. */
  private wait(ms: number, gen: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let t = 0;
      const done = () => {
        clearTimeout(t);
        this.skip = null;
        resolve();
      };
      t = window.setTimeout(done, ms);
      this.skip = done;
      if (gen !== this.gen) done();
    });
  }

  private async runOne(gen: number): Promise<void> {
    const cycle = this.pickCycle();
    const clip = this.clips.get(cycle.preset);
    const liveMs = cycle.amount * 1000;

    // The tip lands.
    this.hudTip.innerHTML = `${escapeHtml(cycle.who)} · <b>$${cycle.amount}</b> · ${escapeHtml(cycle.label.toUpperCase())}`;
    this.hudTip.classList.add("is-on");
    this.hudState.textContent = "AUTHORIZING";
    await sleep(TIP_MS);
    if (gen !== this.gen) return this.showRaw();

    // The cut.
    await this.flash();
    if (gen !== this.gen) return this.showRaw();
    this.setLook(cycle, clip);
    this.feed.classList.add("is-on");
    this.screen.classList.add("is-live");
    this.hudState.textContent = `LIVE · ${cycle.label.toUpperCase()}`;

    // The clock.
    const t0 = performance.now();
    let cut = false;
    this.skip = () => (cut = true);
    while (!cut && gen === this.gen) {
      const left = Math.max(0, liveMs - (performance.now() - t0));
      this.hudBar.style.width = `${100 - (left / liveMs) * 100}%`;
      this.hudCount.textContent = (left / 1000).toFixed(1);
      if (left <= 0) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    this.skip = null;
    if (gen !== this.gen) return this.showRaw();

    // The return.
    this.hudState.textContent = "TEARDOWN";
    await this.flash();
    this.showRaw();
    await sleep(RETURN_MS);
    this.i = (this.i + 1) % CYCLES.length;
  }

  private pickCycle(): Cycle {
    if (this.clips.size === 0) return CYCLES[this.i]!;
    for (let k = 0; k < CYCLES.length; k++) {
      const c = CYCLES[(this.i + k) % CYCLES.length]!;
      if (this.clips.has(c.preset)) {
        this.i = (this.i + k) % CYCLES.length;
        return c;
      }
    }
    return CYCLES[this.i]!;
  }

  private setLook(cycle: Cycle, clip: ClipEntry | undefined): void {
    this.feed.dataset.look = cycle.preset;
    this.identCh.textContent = cycle.ch;
    this.identName.textContent = cycle.label;
    if (clip) {
      this.feed.classList.add("has-video");
      this.feedVideo.hidden = false;
      if (this.feedVideo.getAttribute("src") !== clip.after) this.feedVideo.src = clip.after;
      this.feedVideo.currentTime = 0;
      void this.feedVideo.play().catch(() => {});
      this.setRawClip(clip.before);
    } else {
      this.feed.classList.remove("has-video");
      this.feedVideo.hidden = true;
      this.feedVideo.pause();
      this.setRawClip(undefined);
    }
  }

  private setRawClip(src: string | undefined): void {
    for (const v of [this.rawVideo, this.pipVideo]) {
      if (src) {
        if (v.getAttribute("src") !== src) v.src = src;
        v.hidden = false;
        void v.play().catch(() => {});
      } else {
        v.hidden = true;
        v.pause();
      }
    }
    this.rawLayer.classList.toggle("has-video", Boolean(src));
    this.screen.classList.toggle("no-before", Boolean(this.clips.size) && !src);
  }

  private async flash(): Promise<void> {
    if (REDUCED) return;
    this.wipe.classList.remove("is-on");
    void this.wipe.offsetWidth; // restart the animation
    this.wipe.classList.add("is-on");
    await sleep(WIPE_MS);
  }

  private showRaw(): void {
    this.screen.classList.remove("is-live");
    this.feed.classList.remove("is-on");
    this.feedVideo.pause();
    this.hudTip.classList.remove("is-on");
    this.hudState.textContent = "RAW FEED";
    this.hudBar.style.width = "0%";
    this.hudCount.textContent = "0.0";
    // Keep the raw clip of the upcoming cycle playing under the slate state.
    const upcoming = this.clips.get(CYCLES[this.i]!.preset);
    this.setRawClip(upcoming?.before);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/* ---------- channel grid clips ---------- */

// When a preset has a recorded clip, lay a muted loop over its CSS look and
// only play it while it is on screen.
function hydrateChannels(clips: Map<string, ClipEntry>): void {
  const videos: HTMLVideoElement[] = [];
  for (const li of document.querySelectorAll<HTMLLIElement>(".channel[data-preset]")) {
    const clip = clips.get(li.dataset.preset ?? "");
    const feed = li.querySelector<HTMLElement>(".feed");
    if (!clip || !feed) continue;
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "none";
    v.src = clip.after;
    if (clip.poster) v.poster = clip.poster;
    v.setAttribute("aria-hidden", "true");
    feed.classList.add("has-video");
    feed.prepend(v);
    videos.push(v);
  }
  if (videos.length === 0 || REDUCED) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const v = e.target as HTMLVideoElement;
        if (e.isIntersecting) void v.play().catch(() => {});
        else v.pause();
      }
    },
    { threshold: 0.4 },
  );
  videos.forEach((v) => io.observe(v));
}

/* ---------- nav ---------- */

function initNav(): void {
  const nav = $("nav");
  const toggle = $<HTMLButtonElement>("navToggle");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  nav.querySelectorAll(".nav-links a").forEach((a) =>
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    }),
  );
  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* ---------- boot ---------- */

initNav();
$("year").textContent = String(new Date().getFullYear());

const monitor = new Monitor();
$("watchBtn").addEventListener("click", () => {
  $("screen").scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
  monitor.next();
});

void loadManifest().then((clips) => {
  monitor.setClips(clips);
  monitor.start();
  hydrateChannels(clips);
});
