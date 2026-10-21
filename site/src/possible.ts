// "What's possible": the reader plays the viewer who pays. Pick a kind of edit,
// watch the prompt get typed into the hijack page, pay $5, and the stream switches to the real
// lucy-2.5 render of that prompt for 5 seconds, then cuts back.
//
// One recorded base clip and one render per capability, all the same length and
// frame-aligned (scripts/render-lucy.mjs), so a payment can land at any moment: the
// effect clip is seeked to the base clip's current time and laid over it. The
// prompt shown is the exact text the model received (rewriter off); a render
// whose prompt no longer matches the catalog is treated as missing, never shown
// next to text it wasn't made from.

import catalog from "./capabilities.json";
import { Chat, sleep } from "./chat";

interface Capability {
  id: string;
  label: string;
  blurb: string;
  who: string;
  prompt: string;
  reactions: string[];
}

interface Manifest {
  model: string;
  enhance: boolean;
  mock?: boolean;
  duration: number;
  leadSec: number;
  base: string;
  poster: string;
  clips: Record<string, { src: string; poster: string; prompt: string }>;
}

type Phase = "typing" | "ready" | "paid" | "live" | "done";

const CAPS = catalog.capabilities as Capability[];
const AMOUNT = catalog.amount;
const PAID_MS = 1000;
const WIPE_MS = 420;
const CHAR_MS = 22;
// the product's custom-prompt cap (core/src/submissions.ts MAX_PROMPT_CHARS)
const MAX_CHARS = 500;
const MAX_DRIFT_SEC = 0.12;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const IDLE = [
  "what edit is next",
  "do the parrot one",
  "chat is cooking",
  "hi chat",
  "the lava one was crazy",
  "how is this live",
  "W stream",
  "someone do the blue hair one",
];

async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch("/clips/possible/manifest.json", { cache: "no-cache" });
    return res.ok ? ((await res.json()) as Manifest) : null;
  } catch {
    return null;
  }
}

export function initPossible(): void {
  const root = document.getElementById("possible");
  if (!root) return;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const frame = q<HTMLElement>(".poss-frame");
  const baseV = q<HTMLVideoElement>(".poss-base");
  const fxV = q<HTMLVideoElement>(".poss-fx");
  const wipe = q<HTMLElement>(".wipe");
  const alertEl = q<HTMLElement>(".alert");
  const overlayLook = q<HTMLElement>(".overlay-look");
  const overlayTime = q<HTMLElement>(".overlay-time");
  const overlayBar = q<HTMLElement>(".overlay-bar i");
  const typed = q<HTMLElement>(".poss-typed");
  const promptBox = q<HTMLElement>(".poss-prompt");
  const count = q<HTMLElement>(".poss-count");
  const exact = q<HTMLElement>(".poss-exact");
  const payBtn = q<HTMLButtonElement>(".poss-pay");
  const status = q<HTMLElement>(".poss-status");
  const source = q<HTMLElement>(".poss-source");
  const tabs = CAPS.map((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "tab";
    b.id = `poss-tab-${c.id}`;
    b.dataset.cap = c.id;
    b.setAttribute("aria-controls", "poss-panel");
    b.setAttribute("aria-selected", String(i === 0));
    b.tabIndex = i === 0 ? 0 : -1;
    const n = document.createElement("span");
    n.className = "poss-tab-n";
    n.textContent = String(i + 1).padStart(2, "0");
    const label = document.createElement("b");
    label.textContent = c.label;
    const blurb = document.createElement("small");
    blurb.textContent = c.blurb;
    b.append(n, label, blurb);
    return b;
  });
  q<HTMLElement>(".poss-tabs").append(...tabs);
  const chat = new Chat(q<HTMLElement>(".chat-list"));

  let manifest: Manifest | null = null;
  let cap = CAPS[0]!;
  let phase: Phase = "ready";
  let gen = 0; // bumps on every selection; stale async work checks it and bails
  let finishTyping: (() => void) | null = null;

  const clipFor = (c: Capability) => {
    const clip = manifest?.clips[c.id];
    return clip && clip.prompt === c.prompt ? clip : null;
  };

  function setPhase(p: Phase): void {
    phase = p;
    frame.dataset.phase = p === "live" ? "live" : "idle";
    root!.dataset.phase = p;
    payBtn.disabled = p === "paid" || p === "live";
    payBtn.textContent = p === "done" ? `Pay $${AMOUNT} again` : `Pay $${AMOUNT}`;
    alertEl.classList.toggle("show", p === "paid");
    status.textContent =
      p === "typing" ? "Typing your prompt…"
      : p === "ready" ? `$${AMOUNT} buys ${AMOUNT} seconds on stream.`
      : p === "paid" ? "Paid. Your hijack is starting…"
      : p === "live" ? `LIVE on stream`
      : "Done. Go again, or try another edit.";
  }

  function tick(left: number): void {
    const pct = Math.max(0, Math.min(100, (left / AMOUNT) * 100));
    overlayBar.style.width = `${pct}%`;
    overlayTime.textContent = `0:${String(Math.max(0, Math.ceil(left))).padStart(2, "0")}`;
    if (phase === "live") status.textContent = `LIVE on stream · ${Math.max(0, Math.ceil(left))}s left`;
  }

  function flash(dir: "in" | "out"): void {
    wipe.classList.remove("in", "out");
    void wipe.offsetWidth; // restart the animation
    wipe.classList.add(dir);
  }

  function hideFx(): void {
    frame.dataset.fx = "off";
    fxV.pause();
  }

  /** Where the effect clip should be, given where the base clip is. */
  function target(): number {
    const dur = manifest?.duration || baseV.duration || 1;
    return (baseV.currentTime + (manifest?.leadSec ?? 0)) % dur;
  }

  async function seekFx(): Promise<void> {
    fxV.currentTime = target();
    await Promise.race([new Promise((r) => fxV.addEventListener("seeked", r, { once: true })), sleep(900)]);
  }

  /* ----- selection: type the prompt out like a viewer would ----- */

  async function select(next: Capability, opts: { instant?: boolean } = {}): Promise<void> {
    const my = ++gen;
    finishTyping?.();
    cap = next;
    hideFx();
    flashReset();
    chat.startIdle(IDLE);
    for (const t of tabs) {
      const on = t.dataset.cap === next.id;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    q<HTMLElement>("#poss-panel").setAttribute("aria-labelledby", `poss-tab-${next.id}`);
    overlayLook.textContent = next.label;
    q<HTMLElement>(".alert-text small").textContent = `${next.label} · ${AMOUNT} seconds`;
    exact.hidden = true;

    const clip = clipFor(next);
    if (clip) {
      if (!fxV.src.endsWith(clip.src)) {
        fxV.src = clip.src;
        fxV.poster = clip.poster;
        fxV.load(); // fetch while the prompt types, so the switch is instant
      }
    } else {
      fxV.removeAttribute("src");
    }
    frame.dataset.cap = next.id;
    frame.dataset.clip = root!.dataset.clip = clip ? "real" : "none";
    updateSource();

    const text = next.prompt;
    count.textContent = `${text.length} / ${MAX_CHARS}`;
    if (opts.instant || REDUCED) {
      typed.textContent = text;
      promptBox.dataset.typing = "false";
      exact.hidden = false;
      setPhase("ready");
      return;
    }
    setPhase("typing");
    promptBox.dataset.typing = "true";
    typed.textContent = "";
    let i = 0;
    let skip = false;
    finishTyping = () => (skip = true);
    while (i < text.length && my === gen && !skip) {
      // words arrive in small bursts, with a beat after punctuation
      i++;
      typed.textContent = text.slice(0, i);
      count.textContent = `${i} / ${MAX_CHARS}`;
      const ch = text[i - 1];
      await sleep(ch === "," ? 160 : ch === " " ? CHAR_MS * 1.6 : CHAR_MS * (0.6 + Math.random()));
    }
    if (my !== gen) return;
    finishTyping = null;
    typed.textContent = text;
    count.textContent = `${text.length} / ${MAX_CHARS}`;
    promptBox.dataset.typing = "false";
    exact.hidden = false;
    // Pay pressed mid-typing has already moved the phase on; don't undo it
    if (phase === "typing") setPhase("ready");
  }

  function flashReset(): void {
    wipe.classList.remove("in", "out");
  }

  /* ----- the payment: alert, wipe in, N seconds of the effect, wipe out ----- */

  async function pay(): Promise<void> {
    if (phase === "paid" || phase === "live") return;
    if (finishTyping) {
      finishTyping();
      typed.textContent = cap.prompt;
      promptBox.dataset.typing = "false";
      exact.hidden = false;
    }
    const my = gen;
    const c = cap;
    const live = () => my === gen;
    const clip = clipFor(c);

    setPhase("paid");
    chat.alert({ who: "you", amount: AMOUNT, detail: `${c.label}, ${AMOUNT} seconds`, self: true });
    const ready = clip ? seekFx() : Promise.resolve();
    await Promise.all([sleep(PAID_MS), ready]);
    if (!live()) return;

    flash("in");
    await sleep(WIPE_MS / 2);
    if (!live()) return;
    if (clip) {
      fxV.currentTime = target();
      void fxV.play().catch(() => {});
    }
    frame.dataset.fx = "on";
    setPhase("live");
    void chat.burst(c.reactions, IDLE);

    const t0 = performance.now();
    while (live()) {
      const left = AMOUNT - (performance.now() - t0) / 1000;
      if (left <= 0) break;
      tick(left);
      // keep the effect locked to the base: a few frames of drift reads as a jump
      if (clip && !fxV.seeking) {
        const dur = manifest!.duration;
        let d = Math.abs(fxV.currentTime - target());
        d = Math.min(d, dur - d);
        if (d > MAX_DRIFT_SEC) fxV.currentTime = target();
      }
      await sleep(100);
    }
    if (!live()) return;
    tick(0);

    flash("out");
    await sleep(WIPE_MS / 2);
    if (!live()) return;
    hideFx();
    chat.system(`Your hijack ended: ${c.label}, ${AMOUNT}s.`);
    chat.startIdle(IDLE);
    setPhase("done");
  }

  function updateSource(): void {
    const clip = clipFor(cap);
    if (manifest?.mock) {
      source.dataset.kind = "mock";
      source.textContent = "MOCK RENDER: pipeline test footage, not model output. Do not ship.";
    } else if (clip) {
      source.dataset.kind = "real";
      source.textContent = `Real ${manifest!.model} output, recorded from this exact prompt. Same clip, rendered once per edit.`;
    } else {
      source.dataset.kind = "pending";
      source.textContent = "Preview: the recording of this edit isn't in yet, so the effect is a stand-in tint.";
    }
  }

  /* ----- wiring ----- */

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => {
      const c = CAPS.find((x) => x.id === t.dataset.cap);
      if (c && (c !== cap || phase === "done")) void select(c);
    });
    // arrow keys move between tabs, as the tablist pattern expects
    t.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = tabs[(i + d + tabs.length) % tabs.length]!;
      n.focus();
      n.click();
    });
  });
  payBtn.addEventListener("click", () => void pay());

  // Only decode video while the section is on screen.
  let started = false;
  new IntersectionObserver(
    ([e]) => {
      if (!e) return;
      if (e.isIntersecting) {
        if (baseV.getAttribute("src")) void baseV.play().catch(() => {});
        if (!started) {
          started = true;
          void select(cap);
        }
      } else {
        baseV.pause();
        if (phase !== "live") fxV.pause();
      }
    },
    { threshold: 0.25 },
  ).observe(frame);

  setPhase("ready");
  typed.textContent = cap.prompt;
  for (const line of IDLE.slice(0, 4)) chat.say(line);
  void loadManifest().then((m) => {
    manifest = m;
    if (m?.base) {
      baseV.poster = m.poster;
      baseV.src = m.base;
      frame.dataset.base = "video";
      if (started) void baseV.play().catch(() => {});
    }
    // re-point the current selection at its clip without retyping
    const c = clipFor(cap);
    frame.dataset.clip = root!.dataset.clip = c ? "real" : "none";
    if (c) {
      fxV.src = c.src;
      fxV.poster = c.poster;
      fxV.load();
    }
    updateSource();
  });
}
