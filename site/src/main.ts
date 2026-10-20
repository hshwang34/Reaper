// The site's one moving part: a simulated hijack that every product mock on the
// page follows. One controller runs the phases (idle → tip → live → done) on a
// fixed list of tips, and each render pushes the same state into the stream
// player, the chat column, the viewer portal, the mini player, the OBS dock and
// the ledger.
//
// Nothing here calls the model. The picture is a stock photo treated with CSS
// unless public/clips/manifest.json lists recorded clips, in which case the hero
// plays those for the presets it has (see site/CLIPS.md).

import "./style.css";
import { Particles, type ParticleMode } from "./particles";

/* ---------- theme hook for screenshots (?theme=dark|light) ---------- */

{
  const q = new URLSearchParams(location.search);
  const t = q.get("theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
}

/* ---------- data ---------- */

interface Cycle {
  who: string;
  amount: number;
  preset: string;
  label: string;
  code: string;
}

// Fixed order and amounts so the replay is reproducible. Amounts are small on
// purpose: the countdown runs in real time, one second per dollar.
const CYCLES: Cycle[] = [
  { who: "quartz_ok", amount: 7, preset: "lava-room", label: "Lava Room", code: "K7Q2" },
  { who: "mossy_pond", amount: 6, preset: "underwater", label: "Underwater", code: "P3MD" },
  { who: "vhs_ghost", amount: 5, preset: "80s-anime", label: "80s Anime", code: "V8GH" },
  { who: "neon_rat", amount: 7, preset: "cyberpunk", label: "Cyberpunk City", code: "N4RT" },
  { who: "cellar_door", amount: 9, preset: "haunted", label: "Haunted", code: "C9DR" },
  { who: "snowdayyy", amount: 5, preset: "winter-wonderland", label: "Winter Wonderland", code: "S2NW" },
];

const PARTICLES: Record<string, ParticleMode> = {
  "lava-room": "embers",
  underwater: "bubbles",
  cyberpunk: "rain",
  "winter-wonderland": "snow",
};

// Chat: a small cast with the usual badge mix, and lines for idle time, the
// moment a hijack lands, and the afterglow. All generic; no real handles.
interface Chatter {
  n: string;
  c: string;
  b?: "mod" | "sub" | "vip";
}
const CHATTERS: Chatter[] = [
  { n: "pixel_pat", c: "#ff7a59" },
  { n: "kay_io", c: "#5ec5ff" },
  { n: "marz", c: "#b685ff", b: "sub" },
  { n: "deadl1ne", c: "#59ff9a", b: "mod" },
  { n: "tofu_tv", c: "#ffd166" },
  { n: "nia_exe", c: "#ff5ca8", b: "vip" },
  { n: "borkbork", c: "#8ad7ff" },
  { n: "sunny_d", c: "#ffb86b", b: "sub" },
  { n: "lowpoly", c: "#9ef0e0" },
];
const IDLE_LINES = [
  "LOL",
  "hi chat",
  "anyone else here from the clip",
  "what look is next",
  "do the underwater one again",
  "first time here, what is the hijack thing",
  "the countdown is so good",
  "copying the code rn",
  "W stream",
  "wait so you pick the look and tip? sick",
  "haunted one tonight pls",
];
const BURST_LINES = (c: Cycle): string[] => [
  `${c.who} W`,
  "LETS GOOO",
  "no way",
  "LMAOOO the chair",
  "clip it",
  "hijacked again",
  "it just switched live??",
  `${c.label} is my favorite`,
  "W tipper",
  "ok that's clean",
  "run it back",
  "mine next",
];

interface ClipEntry {
  preset: string;
  /** The model's output. Required. */
  after: string;
  /** Raw camera, time-aligned with `after`. Optional. */
  before?: string;
  poster?: string;
}

type Phase = "idle" | "tip" | "live" | "done";

const IDLE_MS = 2200;
const TIP_MS = 1100;
const WIPE_MS = 420;
const DONE_MS = 800;
const CHAT_MAX = 18;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- helpers ---------- */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.ceil(sec) % 60).padStart(2, "0")}`;
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

async function loadManifest(): Promise<Map<string, ClipEntry>> {
  const map = new Map<string, ClipEntry>();
  try {
    const res = await fetch("/clips/manifest.json", { cache: "no-cache" });
    if (!res.ok) return map;
    const m = (await res.json()) as { clips?: ClipEntry[] };
    for (const c of m.clips ?? []) if (c.after) map.set(c.preset, c);
  } catch {
    /* no clips */
  }
  return map;
}

/* ---------- chat ---------- */

class Chat {
  private list = $("chatList");
  private timer = 0;
  private gen = 0;
  private lastChatter: Chatter | null = null;

  /** Ambient chatter at a human-looking cadence. */
  startIdle(): void {
    this.stop();
    const gen = ++this.gen;
    const loop = () => {
      if (gen !== this.gen) return;
      this.say(pick(IDLE_LINES));
      this.timer = window.setTimeout(loop, 1300 + Math.random() * 1500);
    };
    this.timer = window.setTimeout(loop, 600);
  }

  /** The room reacts: a quick burst, then it settles. */
  async burst(c: Cycle): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    const lines = BURST_LINES(c).sort(() => Math.random() - 0.5).slice(0, 7);
    for (const line of lines) {
      if (gen !== this.gen) return;
      this.say(line);
      await sleep(260 + Math.random() * 320);
    }
    if (gen !== this.gen) return;
    // keep a slower trickle going for the rest of the hijack
    const loop = () => {
      if (gen !== this.gen) return;
      this.say(pick([...IDLE_LINES, ...BURST_LINES(c)]));
      this.timer = window.setTimeout(loop, 900 + Math.random() * 900);
    };
    this.timer = window.setTimeout(loop, 700);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.gen++;
  }

  say(text: string): void {
    let who = pick(CHATTERS);
    if (who === this.lastChatter) who = pick(CHATTERS);
    this.lastChatter = who;
    this.push(
      `<li>${who.b ? `<i class="badge ${who.b}"></i>` : ""}<span class="chat-user" style="color:${who.c}">${esc(who.n)}</span>: ${esc(text)}</li>`,
    );
  }

  alert(c: Cycle): void {
    this.push(
      `<li class="chat-alert"><b>${esc(c.who)}</b> tipped <b>$${c.amount}.00</b> with code ${esc(c.code)}<small>Hijack: ${esc(c.label)}, ${c.amount} seconds</small></li>`,
    );
  }

  system(text: string): void {
    this.push(`<li class="chat-sys">${esc(text)}</li>`);
  }

  private push(html: string): void {
    this.list.insertAdjacentHTML("beforeend", html);
    while (this.list.children.length > CHAT_MAX) this.list.firstElementChild?.remove();
  }

  /** A believable still for reduced motion: some chatter, an alert, reactions. */
  renderStatic(c: Cycle): void {
    this.list.innerHTML = "";
    for (const line of IDLE_LINES.slice(0, 5)) this.say(line);
    this.alert(c);
    for (const line of BURST_LINES(c).slice(0, 5)) this.say(line);
  }
}

/* ---------- the demo ---------- */

class Demo {
  // hero player
  private hero = $("heroFrame");
  private alert = $("alert");
  private overlayBar = $("overlayBar");
  private overlayTime = $("overlayTime");
  private wipe = $("wipe");
  private clipBefore = $<HTMLVideoElement>("clipBefore");
  private clipAfter = $<HTMLVideoElement>("clipAfter");
  private source = $("stageSource");
  private playBtn = $<HTMLButtonElement>("playBtn");
  private uptimeEls = [$("uptime"), $("uptime2")];
  // mirrors
  private mini = $("miniFrame");
  private miniBar = $("miniBar");
  private miniTime = $("miniTime");
  private obs = $("obsFrame");
  private obsSource = $("obsSource");
  private obsStatus = $("obsStatus");
  private portalStatus = $("portalStatus");
  private ledgerBody = $<HTMLTableSectionElement>("ledgerBody");
  private queueList = $("queueList");
  private particles = new Particles($<HTMLCanvasElement>("particles"));
  private chat = new Chat();

  private clips = new Map<string, ClipEntry>();
  private i = 0;
  private gen = 0;
  private paused = REDUCED;
  private skip: (() => void) | null = null;
  private remaining = 0;
  private uptime = 1 * 3600 + 12 * 60 + 46;

  constructor() {
    this.playBtn.addEventListener("click", () => (this.paused ? this.play() : this.pause()));
    $("nextBtn").addEventListener("click", () => this.next());
    this.syncPlayButton();
    if (!REDUCED) window.setInterval(() => this.tickUptime(), 1000);
    this.tickUptime();
  }

  setClips(clips: Map<string, ClipEntry>): void {
    this.clips = clips;
    const first = CYCLES.findIndex((c) => clips.has(c.preset));
    if (first > 0) this.i = first;
  }

  start(): void {
    if (REDUCED) {
      this.source.textContent = "Simulated on a stock photo, paused. Press play to run one hijack.";
      this.renderStatic();
      return;
    }
    this.render("idle", 0);
    this.chat.startIdle();
    void this.loop();
  }

  next(): void {
    if (this.paused) {
      void this.runOne(++this.gen);
      return;
    }
    this.skip?.();
  }

  private play(): void {
    this.paused = false;
    this.syncPlayButton();
    this.chat.startIdle();
    void this.loop();
  }

  private pause(): void {
    this.paused = true;
    this.syncPlayButton();
    this.gen++;
    this.skip = null;
    this.chat.stop();
    this.render("idle", 0);
  }

  private syncPlayButton(): void {
    this.playBtn.dataset.paused = String(this.paused);
    this.playBtn.setAttribute("aria-label", this.paused ? "Play the replay" : "Pause the replay");
  }

  private async loop(): Promise<void> {
    const gen = ++this.gen;
    while (!this.paused && gen === this.gen) {
      await this.runOne(gen);
      if (gen !== this.gen) return;
      await this.wait(IDLE_MS, gen);
    }
  }

  private wait(ms: number, gen: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.skip = () => {
        if (gen === this.gen) done();
      };
    });
  }

  private cycle(offset = 0): Cycle {
    return CYCLES[(this.i + offset + CYCLES.length * 2) % CYCLES.length]!;
  }

  /** One full hijack: tip → wipe → live countdown → wipe → done. */
  private async runOne(gen: number): Promise<void> {
    const c = this.cycle();
    const clip = this.clips.get(c.preset);
    const live = () => gen === this.gen;

    this.render("tip", 0);
    this.chat.alert(c);
    await sleep(TIP_MS);
    if (!live()) return;

    this.flash("in");
    await sleep(WIPE_MS / 2);
    if (!live()) return;

    if (clip) this.playClip(clip);
    this.render("live", c.amount);
    void this.chat.burst(c);

    let skipped = false;
    this.skip = () => {
      if (gen === this.gen) skipped = true;
    };
    const t0 = performance.now();
    while (live() && !skipped) {
      const left = c.amount - (performance.now() - t0) / 1000;
      if (left <= 0) break;
      this.tick(left, c.amount);
      await sleep(100);
    }
    this.skip = null;
    if (!live()) return;

    this.flash("out");
    await sleep(WIPE_MS / 2);
    if (!live()) return;
    this.stopClip();
    this.render("done", 0);
    this.chat.system(`Hijack by ${c.who} ended: ${c.label}, ${c.amount}s. Clip it from the player.`);
    this.addLedgerRow(c);
    await sleep(DONE_MS);
    if (!live()) return;

    this.i = (this.i + 1) % CYCLES.length;
    this.render("idle", 0);
    this.chat.startIdle();
  }

  private flash(dir: "in" | "out"): void {
    this.wipe.classList.remove("in", "out");
    void this.wipe.offsetWidth; // restart the animation
    this.wipe.classList.add(dir);
  }

  private playClip(clip: ClipEntry): void {
    this.hero.dataset.source = "clips";
    this.clipAfter.src = clip.after;
    this.clipAfter.hidden = false;
    void this.clipAfter.play().catch(() => {});
    if (clip.before) {
      this.clipBefore.src = clip.before;
      this.clipBefore.hidden = false;
      void this.clipBefore.play().catch(() => {});
    }
    this.source.textContent = "Recorded output from the model, captured on the rig.";
  }

  private stopClip(): void {
    if (this.hero.dataset.source !== "clips") return;
    delete this.hero.dataset.source;
    for (const v of [this.clipBefore, this.clipAfter]) {
      v.pause();
      v.hidden = true;
      v.removeAttribute("src");
    }
    this.source.textContent = "Simulated on a stock photo. Recordings of the real model are coming.";
  }

  /* ----- rendering: push one state into every screen ----- */

  private render(phase: Phase, remaining: number): void {
    const c = this.cycle();
    const look = phase === "live" ? c.preset : "raw";
    this.remaining = remaining;

    for (const f of [this.hero, this.mini, this.obs]) {
      f.dataset.look = look;
      f.dataset.phase = phase;
    }
    $("alertAvatar").textContent = c.who[0] ?? "?";
    $("alertWho").textContent = c.who;
    $("alertAmt").textContent = `$${c.amount}`;
    $("alertLook").textContent = c.label;
    this.alert.classList.toggle("show", phase === "tip" || (phase === "live" && remaining > c.amount - 2.5));
    for (const id of ["overlayWho", "miniWho"]) $(id).textContent = c.who;
    for (const id of ["overlayLook", "miniLook"]) $(id).textContent = c.label;
    this.tick(remaining, c.amount);
    this.particles.setMode(
      REDUCED || phase !== "live" || this.hero.dataset.source === "clips" ? "none" : (PARTICLES[c.preset] ?? "none"),
    );

    // OBS
    $("obsTag").textContent = `${c.who} · ${c.label}`;
    this.obsSource.dataset.visible = String(phase === "live");
    this.obsStatus.parentElement?.setAttribute("data-live", String(phase === "live"));

    // portal: the viewer's view of this same tip
    for (const b of Array.from($("portalGrid").querySelectorAll<HTMLButtonElement>("button"))) {
      b.setAttribute("aria-pressed", String(b.dataset.preset === c.preset));
    }
    $("portalCode").textContent = c.code;
    const status = this.portalStatus;
    status.dataset.state = phase === "idle" ? "pending" : phase === "tip" ? "queued" : phase;
    status.textContent =
      phase === "idle" ? "Waiting for your tip…"
      : phase === "tip" ? "Tip received — queued!"
      : phase === "live" ? `LIVE · ${Math.ceil(remaining)}s left`
      : "Hijack complete";

    this.renderQueue(phase);
  }

  /** Only the countdown-dependent bits, called at ~10 Hz while live. */
  private tick(remaining: number, total: number): void {
    const pct = total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 100;
    this.overlayBar.style.width = `${pct}%`;
    this.miniBar.style.width = `${pct}%`;
    const t = clock(Math.max(0, remaining));
    this.overlayTime.textContent = t;
    this.miniTime.textContent = t;
    const live = this.hero.dataset.phase === "live";
    this.obsStatus.textContent = live ? `AI Hijack: visible, ${Math.ceil(remaining)}s left` : "AI Hijack: hidden";
    if (live) this.portalStatus.textContent = `LIVE · ${Math.ceil(remaining)}s left`;
    const row = this.queueList.querySelector<HTMLElement>('[data-state="live"] i');
    if (row) row.textContent = `${Math.ceil(remaining)}s left`;
  }

  private tickUptime(): void {
    this.uptime += 1;
    const h = Math.floor(this.uptime / 3600);
    const m = Math.floor((this.uptime % 3600) / 60);
    const s = this.uptime % 60;
    const text = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    for (const el of this.uptimeEls) el.textContent = text;
  }

  /** The queue, pinned at the top of chat: what is live, then who is waiting. */
  private renderQueue(phase: Phase): void {
    const rows: string[] = [];
    const current = this.cycle(0);
    if (phase === "live" || phase === "tip") {
      rows.push(
        `<div class="pin-row" data-state="live"><b>${esc(current.who)}</b><span>${esc(current.label)}</span><i>${phase === "live" ? `${Math.ceil(this.remaining)}s left` : "starting"}</i></div>`,
      );
    }
    const waiting = phase === "idle" || phase === "done" ? [0, 1, 2] : [1, 2, 3];
    for (const k of waiting) {
      const c = this.cycle(k);
      rows.push(`<div class="pin-row"><b>${esc(c.who)}</b><span>${esc(c.label)}</span><i>$${c.amount} → ${c.amount}s</i></div>`);
    }
    this.queueList.innerHTML =
      `<div class="pin-title"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1l5.5 5.5-1.4 1.4-1-1-2.7 2.7.3 3-1.4 1.4-2.6-2.6L2.4 15 1 13.6l3.6-3.6L2 7.4l1.4-1.4 3 .3 2.7-2.7-1-1z"/></svg>Hijack queue, $1 = 1s<em>3 waiting</em></div>` +
      rows.join("");
  }

  private addLedgerRow(c: Cycle): void {
    const tr = document.createElement("tr");
    tr.className = "fresh";
    const now = new Date();
    const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    tr.innerHTML = `<td class="mono">${hhmmss}</td><td>${esc(c.who)}</td><td class="mono">$${c.amount}</td><td class="mono">${c.amount}</td><td class="ok">completed</td><td class="col-prompt">${esc(c.label)}</td>`;
    this.ledgerBody.prepend(tr);
    while (this.ledgerBody.children.length > 4) this.ledgerBody.lastElementChild?.remove();
  }

  private renderStatic(): void {
    const c = this.cycle();
    this.render("live", Math.max(1, c.amount - 3));
    this.alert.classList.add("show");
    this.chat.renderStatic(c);
  }
}

/* ---------- boot ---------- */

const demo = new Demo();
loadManifest()
  .then((clips) => demo.setClips(clips))
  .finally(() => demo.start());
