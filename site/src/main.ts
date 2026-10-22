// The site's moving parts.
//
// 1. The opening demo (HeroDemo): a real recorded stream plus one real lucy-2.5 render of it
//    per effect (public/clips/hero, made by tools/encode-hero.sh). Clicking an effect jumps to
//    that render at the same moment and stays there; "Original" goes back. Until the reader
//    clicks, it shows the effects off on its own. The video work lives in heroPlayer.ts.
//
// 2. The product mocks further down (Mirrors): the hijack page, the stream output, the
//    dashboard and OBS replay one paid hijack after another (pay → live countdown → done),
//    showing stills from the same renders.
//
// Nothing here calls the model.

import "./style.css";
import "./product.css";
import { Chat, IDLE_LINES, esc, sleep } from "./chat";
import { BASE_ID, HeroPlayer, loadHeroManifest, type HeroClip, type HeroManifest } from "./heroPlayer";

/* ---------- theme hook for screenshots (?theme=dark|light) ---------- */

{
  const q = new URLSearchParams(location.search);
  const t = q.get("theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
}

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const AMOUNT = 5;
const ATTRACT_FX_MS = 6000;
const ATTRACT_BASE_MS = 2500;
const WIPE_MS = 420;
const SOURCE_LINE = "Real lucy-2.5 output on the same 30 seconds of stream.";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.ceil(sec) % 60).padStart(2, "0")}`;

/** Who "pays" in the replays, and what chat says about each effect. */
const PAYERS = ["quartz_ok", "mossy_pond", "vhs_ghost", "neon_rat", "cellar_door", "snowdayyy", "polly_wants", "blue_steel"];
const REACTIONS: Record<string, string[]> = {
  statue: ["LADY LIBERTY", "she's still talking lmao", "the crown is moving", "patriotic stream"],
  anime: ["ANIME ARC", "opening theme plays", "the sunset in the window", "it redrew the whole room"],
  ghost: ["BEHIND YOU", "nope nope nope", "don't turn around", "the hands 💀"],
  fire: ["HE'S ON FIRE", "not even sweating", "someone get water", "clip it"],
  slime: ["SLIME 🤢", "it keeps coming", "he's still talking through it", "why is this so smooth"],
  mummy: ["MUMMY STREAM", "kept the headphones lol", "it's wrapped perfectly", "ancient streamer"],
  blonde: ["blonde era", "it suits you ngl", "keep it", "only the hair changed??"],
  "polar-bear": ["BEAR", "the scarf 😭", "bear stream lets go", "he's holding the drink"],
};
const reactionsFor = (c: HeroClip) => [
  ...(REACTIONS[c.id] ?? []),
  `${c.label} is my favorite`,
  "LETS GOOO",
  "it just switched live??",
  "W hijacker",
  "run it back",
];

/* ---------- 1. the opening demo ---------- */

class HeroDemo {
  private frame = $("heroFrame");
  private picker = document.querySelector<HTMLElement>(".demo-picker")!;
  private alert = $("alert");
  private wipe = $("wipe");
  private source = $("stageSource");
  private live = $("heroNow");
  private playBtn = $<HTMLButtonElement>("playBtn");
  private chat = new Chat($("chatList"));
  private pinned = $("queueList");
  private player: HeroPlayer;
  private buttons: HTMLButtonElement[] = [];
  private choices: HeroClip[];
  private touched = false; // the reader clicked: attract mode is over for good
  private attractTimer = 0;
  private alertTimer = 0;
  private attractI = 0;

  constructor(manifest: HeroManifest) {
    this.player = new HeroPlayer(this.frame, manifest, {
      still: REDUCED,
      onShow: (id) => this.shown(id),
      onBlocked: () => this.syncPlayButton(),
    });
    this.choices = [manifest.clips.find((c) => c.id === BASE_ID)!, ...this.player.effects()];
    this.buildPicker();
    this.playBtn.addEventListener("click", () => {
      this.player.setPlaying(!this.player.isPlaying);
      this.syncPlayButton();
    });
    $("nextBtn").addEventListener("click", () => {
      const fx = this.player.effects();
      const i = fx.findIndex((c) => c.id === this.player.current);
      this.choose(fx[(i + 1) % fx.length]!.id);
    });
    this.syncPlayButton();
    this.shown(null);
    for (const line of IDLE_LINES.slice(0, 5)) this.chat.say(line);
    if (!REDUCED) {
      this.chat.startIdle();
      this.attract();
    }
  }

  private buildPicker(): void {
    this.picker.replaceChildren(
      ...this.choices.map((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.effect = c.id;
        b.setAttribute("aria-pressed", String(c.id === BASE_ID));
        const emoji = document.createElement("span");
        emoji.setAttribute("aria-hidden", "true");
        emoji.textContent = c.emoji;
        const label = document.createElement("span");
        label.textContent = c.label;
        b.append(emoji, " ", label);
        const warm = () => this.player.warm(c.id);
        b.addEventListener("pointerenter", warm);
        b.addEventListener("focus", warm);
        b.addEventListener("touchstart", warm, { passive: true });
        b.addEventListener("click", () => this.choose(c.id));
        return b;
      }),
    );
    this.buttons = [...this.picker.querySelectorAll<HTMLButtonElement>("button")];
  }

  /** A reader's pick. */
  private choose(id: string): void {
    this.touched = true;
    clearTimeout(this.attractTimer);
    this.press(id);
    void this.player.show(id);
  }

  private press(id: string): void {
    for (const b of this.buttons) b.setAttribute("aria-pressed", String(b.dataset.effect === id));
  }

  /** Called once the picture really shows the effect (or the original). */
  private shown(id: string | null): void {
    const c = this.player.clip(id ?? BASE_ID)!;
    this.press(c.id);
    const on = id !== null;
    this.frame.dataset.phase = on ? "live" : "idle";
    this.frame.dataset.mode = "stay";
    if (on && !REDUCED) this.flash();
    const who = this.touched ? "you" : PAYERS[this.attractI % PAYERS.length]!;
    $("overlayWho").textContent = who;
    $("overlayLook").textContent = c.label;
    $("alertAvatar").textContent = who[0]!;
    $("alertWho").textContent = who;
    $("alertAmt").textContent = `$${AMOUNT}`;
    $("alertLook").textContent = c.label;
    clearTimeout(this.alertTimer);
    this.alert.classList.toggle("show", on);
    if (on) this.alertTimer = window.setTimeout(() => this.alert.classList.remove("show"), 2600);

    this.source.textContent = on ? `${c.emoji} ${c.description} ${SOURCE_LINE}` : `${c.description} Pick an effect to hijack it.`;
    this.live.textContent = on ? `Now showing: ${c.label}` : "Now showing: the original stream";
    this.pinned.innerHTML =
      `<div class="pin-title"><span class="mini-live"></span>On stream now</div>` +
      (on
        ? `<div class="pin-row" data-state="live"><b>${esc(who)}</b><span>${esc(c.label)}</span><i>live</i></div>`
        : `<div class="pin-row"><b>nova_streams</b><span>Original camera</span><i>pick an effect</i></div>`);

    if (REDUCED) return;
    if (on) {
      this.chat.alert({ who, amount: AMOUNT, detail: `${c.label}`, self: this.touched });
      void this.chat.burst(reactionsFor(c));
    } else {
      this.chat.startIdle();
    }
  }

  private flash(): void {
    this.wipe.classList.remove("in", "out");
    void this.wipe.offsetWidth; // restart the animation
    this.wipe.classList.add("in");
    setTimeout(() => this.wipe.classList.remove("in"), WIPE_MS);
  }

  /** Until the reader clicks: original → an effect → original → the next effect … */
  private attract(): void {
    const fx = this.player.effects();
    const step = (showFx: boolean) => {
      if (this.touched) return;
      if (showFx) {
        const c = fx[this.attractI % fx.length]!;
        this.press(c.id);
        void this.player.show(c.id);
        this.attractTimer = window.setTimeout(() => step(false), ATTRACT_FX_MS);
      } else {
        this.attractI++;
        void this.player.show(null);
        this.attractTimer = window.setTimeout(() => step(true), ATTRACT_BASE_MS);
      }
    };
    this.attractTimer = window.setTimeout(() => step(true), ATTRACT_BASE_MS);
  }

  private syncPlayButton(): void {
    const paused = !this.player.isPlaying;
    this.playBtn.dataset.paused = String(paused);
    this.playBtn.setAttribute("aria-label", paused ? "Play the video" : "Pause the video");
  }
}

/* ---------- 2. the product mocks: one paid hijack after another ---------- */

type Phase = "idle" | "paid" | "live" | "done";

interface Cycle {
  who: string;
  amount: number;
  clip: HeroClip;
}

class Mirrors {
  private mini = $("miniFrame");
  private obs = $("obsFrame");
  private camEls = [this.mini, this.obs].map((f) => f.querySelector<HTMLImageElement>(".cam")!);
  private i = 0;

  constructor(
    private readonly base: HeroClip,
    private readonly cycles: Cycle[],
  ) {
    this.buildPortal();
    this.setStill(base);
    if (REDUCED) this.renderStatic();
    else void this.loop();
  }

  private buildPortal(): void {
    $("portalGrid").replaceChildren(
      ...this.cycles.map(({ clip }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.tabIndex = -1;
        b.dataset.effect = clip.id;
        b.innerHTML = `<span>${esc(clip.emoji)}</span><b>${esc(clip.label)}</b>`;
        return b;
      }),
    );
  }

  private setStill(c: HeroClip): void {
    for (const img of this.camEls) if (img.getAttribute("src") !== c.poster) img.src = c.poster;
  }

  private async loop(): Promise<void> {
    for (;;) {
      const c = this.cycles[this.i % this.cycles.length]!;
      this.render(c, "idle", 0);
      await sleep(2200);
      this.render(c, "paid", 0);
      await sleep(1100);
      this.setStill(c.clip);
      const t0 = performance.now();
      for (;;) {
        const left = c.amount - (performance.now() - t0) / 1000;
        if (left <= 0) break;
        this.render(c, "live", left);
        await sleep(200);
      }
      this.setStill(this.base);
      this.render(c, "done", 0);
      this.addLedgerRow(c);
      await sleep(800);
      this.i++;
    }
  }

  private render(c: Cycle, phase: Phase, left: number): void {
    for (const f of [this.mini, this.obs]) f.dataset.phase = phase === "live" ? "live" : "idle";
    $("miniWho").textContent = c.who;
    $("miniLook").textContent = c.clip.label;
    $("miniTime").textContent = clock(Math.max(0, left));
    $("miniBar").style.width = `${Math.max(0, Math.min(100, (left / c.amount) * 100))}%`;

    $("obsTag").textContent = `${c.who} · ${c.clip.label}`;
    $("obsSource").dataset.visible = String(phase === "live");
    const status = $("obsStatus");
    status.textContent = phase === "live" ? `AI Hijack: visible, ${Math.ceil(left)}s left` : "AI Hijack: hidden";
    status.parentElement?.setAttribute("data-live", String(phase === "live"));

    for (const b of $("portalGrid").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.effect === c.clip.id));
    }
    $("portalAmount").textContent = `$${c.amount} → ${c.amount} seconds of ${c.clip.label}`;
    $("portalCode").textContent = `Pay $${c.amount}`;
    const ps = $("portalStatus");
    ps.dataset.state = phase === "idle" ? "pending" : phase === "paid" ? "queued" : phase;
    ps.textContent =
      phase === "idle" ? "Pick an effect, then pay"
      : phase === "paid" ? "Paid. You're up next!"
      : phase === "live" ? `LIVE · ${Math.ceil(left)}s left`
      : "Hijack complete";
  }

  private addLedgerRow(c: Cycle): void {
    const body = $<HTMLTableSectionElement>("ledgerBody");
    const tr = document.createElement("tr");
    tr.className = "fresh";
    const now = new Date();
    const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
    tr.innerHTML = `<td class="mono">${hhmmss}</td><td>${esc(c.who)}</td><td class="mono">$${c.amount}</td><td class="mono">${c.amount}</td><td class="ok">Played</td><td class="col-prompt">${esc(c.clip.label)}</td>`;
    body.prepend(tr);
    while (body.children.length > 4) body.lastElementChild?.remove();
  }

  private renderStatic(): void {
    const c = this.cycles[0]!;
    this.setStill(c.clip);
    this.render(c, "live", c.amount - 2);
  }
}

/* ---------- uptime ticker (hero + channel row) ---------- */

{
  let uptime = 1 * 3600 + 12 * 60 + 46;
  const els = [$("uptime"), $("uptime2")];
  const tick = () => {
    uptime++;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    for (const el of els) el.textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  tick();
  if (!REDUCED) setInterval(tick, 1000);
}

/* ---------- boot ---------- */

void loadHeroManifest().then((m) => {
  if (!m) {
    $("stageSource").textContent = "The demo video didn't load. Refresh to try again.";
    return;
  }
  new HeroDemo(m);
  const base = m.clips.find((c) => c.id === BASE_ID)!;
  const fx = m.clips.filter((c) => c.id !== BASE_ID);
  new Mirrors(
    base,
    fx.map((clip, i) => ({ clip, who: PAYERS[i % PAYERS.length]!, amount: 5 + (i % 4) })),
  );
});

const menuToggle = document.querySelector<HTMLButtonElement>(".mobile-menu-toggle")!;
const navigation = $("main-navigation");
const closeMenu = () => {
  menuToggle.setAttribute("aria-expanded", "false");
  navigation.classList.remove("is-open");
};
menuToggle.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  menuToggle.setAttribute("aria-expanded", String(open));
  navigation.classList.toggle("is-open", open);
});
navigation.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
    closeMenu();
    menuToggle.focus();
  }
});
