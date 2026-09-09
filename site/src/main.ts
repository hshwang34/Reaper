// Reality Hijack marketing site — the small amount of script the page needs.
//
// 1. The hero monitor: a deterministic loop that plays the product's own
//    state machine at copy level (idle → tip → live(N s) → revert), driven by
//    CSS custom properties. With recorded clips present (public/clips/
//    manifest.json) the monitor shows the real model output; without them it
//    falls back to the CSS "looks", clearly labelled as simulated.
// 2. The $1 = 1s calculator.
// 3. Nav collapse and a scrolled state.
//
// No framework, no runtime dependencies. FAQ uses native <details>.

import "./style.css";

/* ---------- data ---------- */

interface Cycle {
  who: string;
  amount: number;
  preset: string;
  label: string;
  message: string;
}

// Fixed order, fixed amounts: reproducible for screenshots and QA. The first
// cycle matches the headline ($8, lava).
const CYCLES: Cycle[] = [
  { who: "ferret_god_22", amount: 8, preset: "lava-room", label: "Lava Room", message: "lava. now." },
  { who: "mossy_pond", amount: 5, preset: "underwater", label: "Underwater", message: "take a deep breath" },
  { who: "vhs_ghost", amount: 6, preset: "80s-anime", label: "80s Anime", message: "make it 1987" },
  { who: "neon_rat", amount: 7, preset: "cyberpunk", label: "Cyberpunk City", message: "night city arc" },
  { who: "cellar_door", amount: 6, preset: "haunted", label: "Haunted", message: "boo" },
  { who: "snowdayyy", amount: 4, preset: "winter-wonderland", label: "Winter Wonderland", message: "cozy pls" },
];

interface ClipEntry {
  preset: string;
  /** Raw camera, time-aligned with `after`. Optional; the idle frame falls back to the CSS look. */
  before?: string;
  /** The model's output for this preset. */
  after: string;
}
interface Manifest {
  clips: ClipEntry[];
}

const IDLE_MS = 1500;
const TIP_MS = 700;
const WIPE_MS = 400;
const REVERT_MS = 600;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- helpers ---------- */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------- hero monitor ---------- */

class Monitor {
  private screen = $("screen");
  private cam = $("cam");
  private wipe = $("wipe");
  private hudState = $("hudState");
  private hudBy = $("hudBy");
  private tipAlert = $("tipAlert");
  private barFill = $("barFill");
  private countNum = $("countNum");
  private chat = $("chat");
  private note = $("demoNote");
  private pauseBtn = $<HTMLButtonElement>("demoPause");
  private before = $<HTMLVideoElement>("camBefore");
  private after = $<HTMLVideoElement>("camAfter");

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
    this.pauseBtn.textContent = this.paused ? "play" : "pause";
    this.pauseBtn.setAttribute("aria-label", this.paused ? "Play the demo" : "Pause the demo");
  }

  async loadClips(): Promise<void> {
    try {
      const res = await fetch("/clips/manifest.json", { cache: "no-cache" });
      if (!res.ok) return;
      const m = (await res.json()) as Manifest;
      for (const c of m.clips ?? []) if (c.after) this.clips.set(c.preset, c);
    } catch {
      /* no clips: simulated mode */
    }
    if (this.clips.size > 0) {
      this.note.textContent = "Real output from the model, recorded on the rig. Click the screen to trigger the next tip.";
      // Only cycle presets that have a clip, so the hero never shows a CSS
      // stand-in next to real footage.
      const firstWithClip = CYCLES.findIndex((c) => this.clips.has(c.preset));
      if (firstWithClip > 0) this.i = firstWithClip;
    } else {
      this.note.textContent = REDUCED
        ? "Simulated with CSS. Press play to step through a hijack."
        : "Simulated with CSS. Click the screen to trigger the next tip.";
    }
  }

  start(): void {
    if (REDUCED) {
      // Rest on a still, legible frame; the user can step through by hand.
      this.showIdle();
      return;
    }
    void this.loop();
  }

  private play(): void {
    this.paused = false;
    this.pauseBtn.textContent = "pause";
    this.pauseBtn.setAttribute("aria-label", "Pause the demo");
    void this.loop();
  }

  private pause(): void {
    this.paused = true;
    this.pauseBtn.textContent = "play";
    this.pauseBtn.setAttribute("aria-label", "Play the demo");
    this.gen++;
    this.skip = null;
    this.showIdle();
  }

  /** Jump straight to the next tip. */
  private next(): void {
    if (this.paused) {
      // In paused / reduced-motion mode a click runs exactly one cycle.
      void this.runOne(++this.gen);
      return;
    }
    this.skip?.();
  }

  private async loop(): Promise<void> {
    const gen = ++this.gen;
    while (!this.paused && gen === this.gen) {
      await this.runOne(gen);
      if (gen !== this.gen) return;
      await this.wait(IDLE_MS, gen);
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

    // tip
    this.pushChat(cycle);
    this.tipAlert.innerHTML = `<strong>+$${cycle.amount}</strong> → ${cycle.amount}s · ${escapeHtml(cycle.label)}`;
    this.tipAlert.classList.add("is-on");
    this.hudState.textContent = "AUTHORIZING";
    await sleep(TIP_MS);
    if (gen !== this.gen) return this.showIdle();

    // wipe → live
    await this.flash();
    if (gen !== this.gen) return this.showIdle();
    this.tipAlert.classList.remove("is-on");
    this.screen.classList.add("is-live");
    this.hudState.textContent = `LIVE — ${cycle.label}`;
    this.hudBy.textContent = `hijacked by ${cycle.who}`;
    if (clip) {
      this.after.src = clip.after;
      this.after.currentTime = 0;
      void this.after.play().catch(() => {});
      this.after.classList.add("is-showing");
      this.before.classList.remove("is-showing");
      this.cam.dataset.look = "normal";
    } else {
      this.cam.dataset.look = cycle.preset;
    }

    // countdown
    const t0 = performance.now();
    let cut = false;
    const skipNow = () => (cut = true);
    this.skip = skipNow;
    while (!cut && gen === this.gen) {
      const left = Math.max(0, liveMs - (performance.now() - t0));
      this.barFill.style.width = `${(left / liveMs) * 100}%`;
      this.countNum.textContent = `${(left / 1000).toFixed(1)}s`;
      if (left <= 0) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    this.skip = null;
    if (gen !== this.gen) return this.showIdle();

    // revert
    this.hudState.textContent = "TEARDOWN";
    await this.flash();
    this.showIdle();
    await sleep(REVERT_MS);
    this.i = (this.i + 1) % CYCLES.length;
  }

  private pickCycle(): Cycle {
    if (this.clips.size === 0) return CYCLES[this.i]!;
    // Advance to the next cycle that has a real clip.
    for (let k = 0; k < CYCLES.length; k++) {
      const c = CYCLES[(this.i + k) % CYCLES.length]!;
      if (this.clips.has(c.preset)) {
        this.i = (this.i + k) % CYCLES.length;
        return c;
      }
    }
    return CYCLES[this.i]!;
  }

  private async flash(): Promise<void> {
    if (REDUCED) return;
    this.wipe.classList.remove("is-on");
    void this.wipe.offsetWidth; // restart the animation
    this.wipe.classList.add("is-on");
    await sleep(WIPE_MS);
  }

  private showIdle(): void {
    this.screen.classList.remove("is-live");
    this.tipAlert.classList.remove("is-on");
    this.hudState.textContent = "NORMAL";
    this.hudBy.textContent = "";
    this.barFill.style.width = "0%";
    this.countNum.textContent = "0.0s";
    this.cam.dataset.look = "normal";
    this.after.classList.remove("is-showing");
    this.after.pause();
    const idleClip = this.clips.get(CYCLES[this.i]!.preset)?.before;
    if (idleClip) {
      if (this.before.getAttribute("src") !== idleClip) this.before.src = idleClip;
      void this.before.play().catch(() => {});
      this.before.classList.add("is-showing");
    } else {
      this.before.classList.remove("is-showing");
    }
  }

  private pushChat(c: Cycle): void {
    for (const old of this.chat.querySelectorAll(".chat-line")) old.classList.add("is-old");
    const line = document.createElement("div");
    line.className = "chat-line";
    line.innerHTML = `<span class="who">${escapeHtml(c.who)}</span><span class="amt">$${c.amount}</span><span>${escapeHtml(c.message)}</span>`;
    this.chat.append(line);
    while (this.chat.children.length > 3) this.chat.firstElementChild?.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/* ---------- showcase clips ---------- */

// When a preset has a recorded clip, lay a muted looping video over its CSS
// thumbnail and only play it while it's on screen.
async function hydrateLookGrid(): Promise<void> {
  let manifest: Manifest | null = null;
  try {
    const res = await fetch("/clips/manifest.json", { cache: "no-cache" });
    if (res.ok) manifest = (await res.json()) as Manifest;
  } catch {
    return;
  }
  if (!manifest) return;
  const byPreset = new Map(manifest.clips.map((c) => [c.preset, c]));
  const videos: HTMLVideoElement[] = [];
  for (const li of document.querySelectorAll<HTMLLIElement>(".look[data-preset]")) {
    const clip = byPreset.get(li.dataset.preset ?? "");
    const cam = li.querySelector<HTMLElement>(".cam");
    if (!clip || !cam) continue;
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "none";
    v.src = clip.after;
    v.className = "is-showing";
    v.setAttribute("aria-hidden", "true");
    cam.prepend(v);
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

/* ---------- $1 = 1s calculator ---------- */

const GPU_PER_SEC = 0.02; // Decart lucy-2.5 published rate (README, FEASIBILITY §4)

function initCalc(): void {
  const range = $<HTMLInputElement>("tipRange");
  const dollars = $("calcDollars");
  const seconds = $("calcSeconds");
  const keep = $("calcKeep");
  const gpu = $("calcGpu");
  const share = $("calcShare");
  const render = () => {
    const n = Number(range.value);
    dollars.textContent = String(n);
    seconds.textContent = String(n);
    keep.textContent = n.toFixed(2);
    gpu.textContent = (n * GPU_PER_SEC).toFixed(2);
    share.textContent = String(Math.round(GPU_PER_SEC * 100));
  };
  range.addEventListener("input", render);
  render();
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
initCalc();
$("year").textContent = String(new Date().getFullYear());
const monitor = new Monitor();
void monitor.loadClips().then(() => monitor.start());
void hydrateLookGrid();
