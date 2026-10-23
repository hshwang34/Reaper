// The Control section's guardrails panel: a working copy of the streamer's settings, with
// three example setups for different audiences. Every control maps to a real setting in
// shared/src/settings.ts (minTipUSD, maxDurationSec, cooldownSec, queueDepth, maxIntensity,
// allowedCategories, customPrompts, referenceImages, showAiLabel); the audience setups are
// just example values for them. Nothing here talks to a server.

import type { HeroClip } from "./heroPlayer";

type Category = "environment" | "character" | "horror" | "chaotic";
type Ideas = "off" | "classified" | "classified+approval";
type Photos = "off" | "scenes" | "likeness";

interface Rules {
  minUsd: number;
  maxSec: number;
  cooldown: number;
  queue: number;
  wild: number;
  cats: Category[];
  ideas: Ideas;
  photos: Photos;
  aiLabel: boolean;
}

const ALL_CATS: Category[] = ["environment", "character", "horror", "chaotic"];

/** Example setups. "Anything goes" is the product's default (DEFAULT_SETTINGS). */
const AUDIENCES: Record<string, Rules> = {
  family: { minUsd: 3, maxSec: 20, cooldown: 10, queue: 3, wild: 2, cats: ["environment", "character"], ideas: "classified+approval", photos: "off", aiLabel: true },
  chill: { minUsd: 2, maxSec: 30, cooldown: 5, queue: 5, wild: 3, cats: ["environment", "character", "horror"], ideas: "classified", photos: "scenes", aiLabel: true },
  wild: { minUsd: 2, maxSec: 60, cooldown: 3, queue: 5, wild: 5, cats: [...ALL_CATS], ideas: "classified", photos: "likeness", aiLabel: true },
};

/** How each demo effect is filed in the catalog (category + how intense it is, 1-5). */
const EFFECT_RULES: Record<string, { cat: Category; level: number }> = {
  blonde: { cat: "character", level: 1 },
  anime: { cat: "environment", level: 2 },
  statue: { cat: "character", level: 2 },
  "polar-bear": { cat: "character", level: 2 },
  ghost: { cat: "horror", level: 3 },
  mummy: { cat: "horror", level: 3 },
  slime: { cat: "chaotic", level: 3 },
  fire: { cat: "chaotic", level: 4 },
};

const WILD_NAMES = ["", "Mild", "Silly", "Spooky", "Wild", "Unhinged"];
const IDEAS_TEXT: Record<Ideas, string> = {
  off: "Effects from your list only",
  classified: "Their own ideas too, screened first",
  "classified+approval": "Their own ideas too, screened, then you approve each one",
};
const PHOTOS_TEXT: Record<Photos, string> = {
  off: "No photo uploads",
  scenes: "Photos of places and styles, no faces",
  likeness: "Photos with faces, only with the person's consent",
};

const secs = (n: number) => `${n} second${n === 1 ? "" : "s"}`;

export function initGuardrails(clips: HeroClip[]): void {
  const form = document.querySelector<HTMLFormElement>("#guardrails");
  if (!form) return;
  const q = <T extends Element>(sel: string) => form.querySelector<T>(sel)!;
  const out = (k: string, text: string) => {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-g=${k}]`)) el.textContent = text;
  };
  const range = (name: string) => q<HTMLInputElement>(`input[name=${name}]`);
  const radio = (name: string) => q<HTMLInputElement>(`input[name=${name}]:checked`).value;

  // the effect tiles in the summary
  const grid = document.getElementById("grEffects");
  const effects = clips.filter((c) => EFFECT_RULES[c.id]);
  if (grid) {
    grid.innerHTML = "";
    for (const c of effects) {
      const tile = document.createElement("li");
      tile.dataset.id = c.id;
      tile.innerHTML = `<img src="${c.poster}" alt="" loading="lazy" width="96" height="54" /><span>${c.emoji} ${c.label}</span>`;
      grid.append(tile);
    }
  }

  const read = (): Rules => ({
    minUsd: Number(range("minUsd").value),
    maxSec: Number(range("maxSec").value),
    cooldown: Number(range("cooldown").value),
    queue: Number(range("queue").value),
    wild: Number(radio("wild")),
    cats: ALL_CATS.filter((c) => q<HTMLInputElement>(`input[name=cat][value=${c}]`).checked),
    ideas: radio("ideas") as Ideas,
    photos: radio("photos") as Photos,
    aiLabel: q<HTMLInputElement>("input[name=aiLabel]").checked,
  });

  const write = (r: Rules) => {
    range("minUsd").value = String(r.minUsd);
    range("maxSec").value = String(r.maxSec);
    range("cooldown").value = String(r.cooldown);
    range("queue").value = String(r.queue);
    q<HTMLInputElement>(`input[name=wild][value="${r.wild}"]`).checked = true;
    for (const c of ALL_CATS) q<HTMLInputElement>(`input[name=cat][value=${c}]`).checked = r.cats.includes(c);
    q<HTMLInputElement>(`input[name=ideas][value="${r.ideas}"]`).checked = true;
    q<HTMLInputElement>(`input[name=photos][value="${r.photos}"]`).checked = true;
    q<HTMLInputElement>("input[name=aiLabel]").checked = r.aiLabel;
  };

  const same = (a: Rules, b: Rules) => JSON.stringify(a) === JSON.stringify(b);

  const render = () => {
    const r = read();
    const maxUsd = r.maxSec; // $1 = 1 second
    out("minUsd", `$${r.minUsd}`);
    out("minSec", secs(r.minUsd));
    out("maxSec", secs(r.maxSec));
    out("maxUsd", `$${maxUsd}`);
    out("cooldown", r.cooldown === 0 ? "No wait" : `${r.cooldown} s`);
    out("queue", String(r.queue));
    out("wildName", WILD_NAMES[r.wild]!);
    out("range", r.minUsd === maxUsd ? `$${r.minUsd}` : `$${r.minUsd} – $${maxUsd}`);
    out("rangeSec", r.minUsd === r.maxSec ? secs(r.maxSec) : `${r.minUsd} to ${secs(r.maxSec)}`);
    out(
      "line",
      `Up to ${r.queue} hijack${r.queue === 1 ? "" : "s"} wait in line${r.cooldown ? `, ${r.cooldown} s apart` : ", back to back"}.`,
    );
    out("ideas", IDEAS_TEXT[r.ideas]);
    out("photos", PHOTOS_TEXT[r.photos]);
    out("aiLabel", r.aiLabel ? "“AI effect” label shows on stream" : "No AI label on stream");

    let on = 0;
    for (const tile of grid?.querySelectorAll<HTMLElement>("li") ?? []) {
      const rule = EFFECT_RULES[tile.dataset.id!]!;
      const ok = r.cats.includes(rule.cat) && rule.level <= r.wild;
      tile.dataset.on = String(ok);
      if (ok) on++;
    }
    out("count", `${on} of ${effects.length} effects on`);

    const match = Object.entries(AUDIENCES).find(([, a]) => same(a, r))?.[0] ?? "";
    for (const b of form.querySelectorAll<HTMLButtonElement>("[data-audience]")) {
      b.setAttribute("aria-pressed", String(b.dataset.audience === match));
    }
    out("audience", match ? "" : "Custom setup");
  };

  form.addEventListener("input", (e) => {
    // the longest hijack can't be shorter than the shortest one
    const t = e.target as HTMLInputElement;
    if (t.name === "minUsd" && Number(range("maxSec").value) < Number(t.value)) range("maxSec").value = t.value;
    if (t.name === "maxSec" && Number(range("minUsd").value) > Number(t.value)) range("minUsd").value = t.value;
    render();
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  for (const b of form.querySelectorAll<HTMLButtonElement>("[data-audience]")) {
    b.addEventListener("click", () => {
      write(AUDIENCES[b.dataset.audience!]!);
      render();
    });
  }
  write(AUDIENCES.wild!);
  render();
}
