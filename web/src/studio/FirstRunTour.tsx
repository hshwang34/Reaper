// First-run tour: four cards that explain the product before the streamer
// sees a single control — what chat does, what happens to the camera, that
// it always reverts, and that the streamer stays in charge. The visible
// slide's art autoplays (it IS the product demo) and stops when the slide
// changes; under reduced motion it stays still with a play button. Shown once after
// setup (remembered per machine), re-openable from "How it works".

import { useEffect, useState } from "react";
import { PRESETS_BY_ID, type Preset } from "@rh/shared";
import { EffectArt, PreviewPlayButton } from "../features/EffectArt.js";
import { PANIC_KEY } from "../lib/platform.js";
import { btn } from "./ui.js";

const KEY = "rhStudioTourSeen";

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true; // storage blocked: never trap the streamer in a tour
  }
}
function markSeen() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore */
  }
}

const p = (id: string) => PRESETS_BY_ID[id] as Preset;

const STEPS: { title: string; body: string; art: Preset[]; caption?: string }[] = [
  {
    title: "Chat takes over your camera",
    body: "They open your hijack link, pick an effect or write their own idea, and pay. $1 buys 1 second.",
    art: [p("cyberpunk"), p("watercolor"), p("space-explorer")],
  },
  {
    title: "Your stream changes, live",
    body: "Stream Hijack turns your webcam into the effect and shows it in OBS, right over your camera.",
    art: [p("lava-room")],
    caption: "Lava Room · 15 seconds · paid by someone in chat",
  },
  {
    title: "Then it snaps back",
    body: "When the paid time runs out, your normal camera returns. The next person in line goes after a short pause.",
    art: [p("winter-wonderland"), p("parrot-party")],
  },
  {
    title: "You're always in control",
    body: `Press Esc, or ${PANIC_KEY} from any app, to stop an effect and pause new ones. Choose which effects are on, and whether chat can write ideas or add photos, in Rules.`,
    art: [p("knight")],
  },
];

export function FirstRunTour({ onDone }: { onDone: (goTo: "effects" | "live") => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  const finish = (goTo: "effects" | "live") => {
    markSeen();
    onDone(goTo);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && !last) setI(i + 1);
      if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
      if (e.key === "Escape") finish("live");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, last]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-3xl overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className={`grid gap-1 p-1 ${step.art.length === 3 ? "grid-cols-3" : step.art.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
          {step.art.map((a) => (
            <div key={a.id} className="relative overflow-hidden rounded-2xl">
              <EffectArt preset={a} size={step.art.length === 1 ? "lg" : "md"} autoPlay />
              <PreviewPlayButton id={a.id} label={a.label} reducedMotionOnly />
              <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-zinc-100">
                {a.label}
              </span>
            </div>
          ))}
        </div>
        <div className="p-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-400">
            How it works · {i + 1} of {STEPS.length}
          </p>
          <h2 id="tour-title" className="mt-2 text-3xl font-bold tracking-tight text-zinc-50">
            {step.title}
          </h2>
          <p className="mt-3 max-w-xl text-lg leading-relaxed text-zinc-300">{step.body}</p>
          {step.caption && <p className="mt-2 text-sm text-zinc-500">{step.caption}</p>}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <div className="mr-auto flex gap-1.5" aria-hidden>
              {STEPS.map((_, n) => (
                <span key={n} className={`h-1.5 w-6 rounded-full ${n === i ? "bg-brand-500" : "bg-zinc-700"}`} />
              ))}
            </div>
            {!last && (
              <button className={btn.ghost} onClick={() => finish("live")}>
                Skip
              </button>
            )}
            {i > 0 && (
              <button className={btn.ghost} onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
            {last ? (
              <>
                <button className={btn.secondary} onClick={() => finish("live")}>
                  Go to Live
                </button>
                <button className={btn.primary} onClick={() => finish("effects")} autoFocus>
                  Explore the effects
                </button>
              </>
            ) : (
              <button className={btn.primary} onClick={() => setI(i + 1)} autoFocus>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
