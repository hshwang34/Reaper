// The viewer's view of the safety checks (docs/CONTENT-SAFETY.md S1/S2).
//
// While a submission is being checked, the server streams the exact list of
// checks it runs and each one's state as it resolves; this renders that as a
// live checklist instead of a spinner — the checks take a few seconds (the
// policy LLM is the slow one) and a silent button for that long reads as
// broken. When the submission fails, it lists EVERY failure point: which
// check caught it, what it caught, and — for the prompt — the exact words,
// highlighted in place. It says what failed, never how to get past it.

import { useEffect, useRef, useState } from "react";
import type { CheckResult, CheckState, SafetyFinding, SafetySubject } from "@rh/shared";

const SUBJECT_TITLE: Record<SafetySubject, string> = {
  prompt: "Your prompt",
  photo: "Your photo",
};

const STATE_TEXT: Record<CheckState, string> = {
  pending: "Waiting",
  running: "Checking…",
  pass: "Passed",
  review: "Streamer approves",
  fail: "Failed",
  unavailable: "Couldn't run",
  skipped: "Skipped",
};

const STATE_TONE: Record<CheckState, string> = {
  pending: "text-zinc-600",
  running: "text-cyan-300",
  pass: "text-emerald-400",
  review: "text-amber-300",
  fail: "text-red-400",
  unavailable: "text-zinc-400",
  skipped: "text-zinc-600",
};

function StateIcon({ state }: { state: CheckState }) {
  const base = "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold";
  switch (state) {
    case "running":
      return (
        <span
          aria-hidden
          className="h-5 w-5 shrink-0 rounded-full border-2 border-cyan-400/25 border-t-cyan-300 motion-safe:animate-spin"
        />
      );
    case "pass":
      return <span aria-hidden className={`${base} bg-emerald-500/15 text-emerald-300`}>✓</span>;
    case "fail":
      return <span aria-hidden className={`${base} bg-red-500/15 text-red-300`}>✕</span>;
    case "review":
      return <span aria-hidden className={`${base} bg-amber-500/15 text-amber-300`}>!</span>;
    case "unavailable":
      return <span aria-hidden className={`${base} bg-zinc-700/40 text-zinc-300`}>–</span>;
    case "skipped":
      return <span aria-hidden className={`${base} border border-dashed border-zinc-700 text-zinc-600`} />;
    default:
      return <span aria-hidden className={`${base} border border-zinc-700`} />;
  }
}

/** Seconds since `active` became true; resets when it goes false. */
function useElapsed(active: boolean): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    setSecs(0);
    if (!active) return;
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [active]);
  return secs;
}

/**
 * The live checklist. `preparing` is the client-side stretch before the
 * server's plan arrives (shrinking the photo, uploading it).
 */
export function SafetyChecklist({
  checks,
  preparing,
  running,
  stale = false,
}: {
  checks: CheckResult[];
  preparing: string | null;
  running: boolean;
  /** These results describe a version the viewer has since edited. */
  stale?: boolean;
}) {
  const elapsed = useElapsed(running);
  const finished = checks.filter((c) => c.state !== "pending" && c.state !== "running").length;
  const subjects = (["prompt", "photo"] as const).filter((s) => checks.some((c) => c.subject === s));

  return (
    <section
      aria-label="Safety checks"
      aria-live="polite"
      aria-busy={running}
      className={`rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 transition-opacity ${stale ? "opacity-50" : ""}`}
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Safety checks</h3>
        <span className="text-xs tabular-nums text-zinc-500">
          {preparing ?? (checks.length ? `${finished} of ${checks.length}` : "")}
        </span>
      </div>

      {preparing && !checks.length && (
        <div className="flex items-center gap-3 text-sm text-zinc-300">
          <StateIcon state="running" />
          {preparing}
        </div>
      )}

      <div className="space-y-3">
        {subjects.map((subject) => (
          <div key={subject}>
            {subjects.length > 1 && (
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                {SUBJECT_TITLE[subject]}
              </p>
            )}
            <ul className="space-y-1.5">
              {checks
                .filter((c) => c.subject === subject)
                .map((c) => (
                  <li key={c.id} className="flex items-center gap-3 text-sm">
                    <StateIcon state={c.state} />
                    <span className={c.state === "pending" || c.state === "skipped" ? "text-zinc-500" : "text-zinc-200"}>
                      {c.label}
                    </span>
                    <span className={`ml-auto text-xs ${STATE_TONE[c.state]}`}>{STATE_TEXT[c.state]}</span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>

      {running && elapsed >= 5 && (
        <p className="mt-3 text-xs text-zinc-500">
          Still checking — reading a request against the stream's rules can take a few seconds.
        </p>
      )}
    </section>
  );
}

/** Every failure point, grouped by what it was found in. */
export function SafetyFindings({
  findings,
  checks,
  prompt,
  stale,
}: {
  findings: SafetyFinding[];
  checks: CheckResult[];
  /** The prompt as it was checked — its flagged words are highlighted. */
  prompt: string | null;
  /** The viewer has edited since — these results describe an older version. */
  stale: boolean;
}) {
  const labelOf = (id: string) => checks.find((c) => c.id === id)?.label ?? "Safety check";
  const subjects = (["prompt", "photo"] as const).filter((s) => findings.some((f) => f.subject === s));
  const flagged = findings.filter((f) => f.subject === "prompt").flatMap((f) => f.matches ?? []);
  // On a phone the panel can land below the fold — bring it into view once.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [findings]);

  return (
    <section
      ref={ref}
      role="alert"
      className={`rounded-xl border border-red-500/40 bg-red-950/20 p-4 transition-opacity ${stale ? "opacity-50" : ""}`}
    >
      <h3 className="font-semibold text-red-300">
        Didn't pass — {findings.length} {findings.length === 1 ? "problem" : "problems"} found
      </h3>
      {stale && <p className="mt-0.5 text-xs text-zinc-400">You've edited since — submit again to re-check.</p>}

      {prompt && flagged.length > 0 && (
        <p className="mt-3 rounded-lg bg-zinc-950/60 px-3 py-2 text-sm leading-relaxed text-zinc-300">
          <Highlighted text={prompt} phrases={flagged} />
        </p>
      )}

      <div className="mt-3 space-y-3">
        {subjects.map((subject) => (
          <div key={subject}>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              {SUBJECT_TITLE[subject]}
            </p>
            <ul className="space-y-2">
              {groupFindings(findings.filter((f) => f.subject === subject)).map((g) => (
                <li key={`${g.check}:${g.category}`} className="flex items-start gap-3">
                  <StateIcon state="fail" />
                  <div className="min-w-0 text-sm">
                    <p className="text-zinc-100">
                      {g.label}
                      <span className="ml-2 text-xs text-zinc-500">· {labelOf(g.check)}</span>
                    </p>
                    {g.matches.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1.5">
                        {g.matches.map((m) => (
                          <span key={m} className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-xs text-red-200">
                            {m}
                          </span>
                        ))}
                      </p>
                    )}
                    {g.detail && <p className="mt-0.5 text-xs text-zinc-400">{sentence(g.detail)}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The blocklist reports one finding per word; show one row per category
 *  per check, with all its words as chips. */
function groupFindings(list: SafetyFinding[]) {
  const groups: Array<{ check: string; category: string; label: string; detail?: string; matches: string[] }> = [];
  for (const f of list) {
    const g = groups.find((x) => x.check === f.check && x.category === f.category);
    if (g) {
      g.matches.push(...(f.matches ?? []).filter((m) => !g.matches.includes(m)));
      g.detail ??= f.detail;
    } else {
      groups.push({ check: f.check, category: f.category, label: f.label, detail: f.detail, matches: [...(f.matches ?? [])] });
    }
  }
  return groups;
}

/** `text` with each phrase marked. Letters/digits bound a match, so "sex"
 *  doesn't light up inside "essex"; `_`/`-` count as separators, as they do
 *  for the server's blocklist. */
function Highlighted({ text, phrases }: { text: string; phrases: string[] }) {
  const escaped = [...new Set(phrases)]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return <>{text}</>;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <mark key={at} className="rounded bg-red-500/25 px-0.5 text-red-100">
        {m[0]}
      </mark>,
    );
    last = at + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
