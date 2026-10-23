// The setup guide: Mac/Windows instructions, "Done" ticks remembered in this browser, a
// progress meter, and a step rail that follows the scroll. Ticks are a per-viewer
// convenience, so storage failures are ignored and the page works without them.
import "./style.css";
import "./product.css";
import "./trust.css";
import "./setup.css";
import { applyLinks } from "./links";

applyLinks();

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: ticks just won't be remembered */
    }
  },
};

/* ---------- Mac / Windows ---------- */

const detected = /Win/i.test(navigator.platform || navigator.userAgent) ? "win" : "mac";
const setOs = (os: string) => {
  document.documentElement.dataset.os = os;
  const r = document.querySelector<HTMLInputElement>(`input[name=os][value=${os}]`);
  if (r) r.checked = true;
};
setOs(store.get("rh-setup-os") ?? detected);
for (const r of document.querySelectorAll<HTMLInputElement>("input[name=os]")) {
  r.addEventListener("change", () => {
    setOs(r.value);
    store.set("rh-setup-os", r.value);
  });
}

/* ---------- done ticks + progress ---------- */

const boxes = [...document.querySelectorAll<HTMLInputElement>("input[data-step]")];
const KEY = "rh-setup-done";
const saved = new Set((store.get(KEY) ?? "").split(",").filter(Boolean));
const count = document.getElementById("suCount")!;
const meter = document.getElementById("suMeter")!;
const reset = document.getElementById("suReset")!;

const render = () => {
  const done = boxes.filter((b) => b.checked);
  count.textContent = `${done.length} of ${boxes.length}`;
  meter.style.width = `${(done.length / boxes.length) * 100}%`;
  reset.hidden = done.length === 0;
  for (const b of boxes) {
    b.closest(".su-step")?.classList.toggle("is-done", b.checked);
    document.querySelector(`[data-rail="${b.dataset.step}"]`)?.classList.toggle("is-done", b.checked);
  }
  store.set(KEY, done.map((b) => b.dataset.step).join(","));
};
for (const b of boxes) {
  b.checked = saved.has(b.dataset.step!);
  b.addEventListener("change", () => {
    render();
    // move on to the next unfinished step
    if (b.checked) {
      const next = boxes.slice(boxes.indexOf(b) + 1).find((x) => !x.checked);
      const target = next?.closest(".su-step") ?? document.getElementById("live");
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    }
  });
}
reset.addEventListener("click", () => {
  for (const b of boxes) b.checked = false;
  render();
  window.scrollTo({ top: 0 });
});
render();

/* ---------- rail follows the scroll ---------- */

const links = new Map(
  [...document.querySelectorAll<HTMLAnchorElement>("[data-rail]")].map((a) => [a.dataset.rail!, a]),
);
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const [id, a] of links) {
        if (id === e.target.id) a.setAttribute("aria-current", "step");
        else a.removeAttribute("aria-current");
      }
    }
  },
  { rootMargin: "-40% 0px -55% 0px" },
);
for (const s of document.querySelectorAll(".su-step")) io.observe(s);
