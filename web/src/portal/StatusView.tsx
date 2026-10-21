// After submitting: the live status of one hijack. Paid (Stripe) viewers see
// just the status card; the local rig shows the claim code to put in a tip
// message, plus a dev-only "simulate the tip" shortcut.

import type { SubmissionStatus } from "@rh/shared";
import { channelSlug } from "../lib/channel.js";

export function ClaimView(props: {
  /** Paid through Stripe: there's no code to copy, just the live status. */
  paid: boolean;
  code: string;
  secsLeft: number | null;
  status: SubmissionStatus | null;
  tipAmount: number;
  durationPreview: number;
  /** Safety checks this submission passed (0 for a plain preset). */
  passedChecks: number;
  onSimulate: () => void;
  onReset: () => void;
}) {
  const { code, secsLeft, status, tipAmount, durationPreview, passedChecks } = props;
  // The claim-code TTL only matters while we're still waiting for a tip. Once a
  // tip has matched (queued/live/done/failed), the code is consumed server-side
  // — so a lapsed TTL must not overwrite a real terminal state (e.g. flip a
  // completed "done" into a false "expired" if the viewer lingers on the page).
  const stillWaiting = !status || status.state === "pending";
  const expired = status?.state === "expired" || (stillWaiting && secsLeft === 0);
  const terminal = expired || status?.state === "done" || status?.state === "failed";

  if (props.paid) {
    return (
      <div className="mx-auto max-w-md space-y-5 text-center">
        <StatusCard status={status} expired={false} paid />
        {status?.state === "failed" && (
          <p className="text-sm text-zinc-400">
            If it never started, you're refunded automatically — it can take a
            few days to show on your statement.
          </p>
        )}
        <button
          type="button"
          onClick={props.onReset}
          className="min-h-12 w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-5 font-semibold text-zinc-100 hover:border-zinc-500"
        >
          Hijack again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-5 text-center">
      <div className="rounded-3xl border border-brand-400/40 bg-[radial-gradient(circle_at_50%_0%,rgba(255,121,92,.16),transparent_70%)] p-6">
        <p className="text-sm text-zinc-300">Put this code in your tip message</p>
        <p className="my-3 font-mono text-5xl font-black tracking-[0.3em] text-brand-300">{code}</p>
        {stillWaiting && secsLeft != null && !expired && (
          <p className="text-sm tabular-nums text-zinc-400">
            Expires in {Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, "0")}
          </p>
        )}
        {passedChecks > 0 && (
          <p className="mt-3 text-sm text-emerald-400">
            ✓ Passed {passedChecks === 1 ? "the safety check" : `all ${passedChecks} safety checks`}
          </p>
        )}
      </div>

      <StatusCard status={status} expired={expired} />

      {/* Dev-only shortcut: fire the same server path a real Streamlabs tip
          would, so the whole demo runs on one machine. Hidden on the hosted
          portal (/c/…) — there the endpoint is streamer-authed and viewers
          pay through the real tip rail. */}
      {!channelSlug() && (
        <div className="rounded-2xl border border-dashed border-zinc-700 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-400">
            Demo · simulate the tip
          </p>
          <button
            type="button"
            onClick={props.onSimulate}
            disabled={terminal}
            className="min-h-11 w-full rounded-xl bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Send ${tipAmount} test tip ({durationPreview}s)
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={props.onReset}
        className="min-h-11 text-sm text-zinc-400 underline underline-offset-4 hover:text-zinc-100"
      >
        Start over
      </button>
    </div>
  );
}

function StatusCard({
  status,
  expired,
  paid = false,
}: {
  status: SubmissionStatus | null;
  expired: boolean;
  paid?: boolean;
}) {
  const state = expired ? "expired" : (status?.state ?? "pending");
  const label: Record<string, string> = {
    pending: paid ? "Starting soon…" : "Waiting for your tip…",
    review: "Tip received — waiting for the streamer to approve…",
    matched: "Tip received — queued!",
    queued: `You're in line${status?.queuePosition ? ` · position ${status.queuePosition}` : ""}`,
    live: "LIVE on stream now",
    done: "Hijack complete",
    expired: "Expired — no tip arrived in time.",
    failed: `Failed — ${status?.message ?? "error"}`,
  };
  const icon: Record<string, string> = {
    pending: "⏳",
    review: "👀",
    matched: "🎟️",
    queued: "🎟️",
    live: "🔴",
    done: "🎉",
    expired: "⌛",
    failed: "⚠️",
  };
  const tone =
    state === "live"
      ? "border-brand-400/60 bg-brand-500/10"
      : state === "done"
        ? "border-emerald-500/40 bg-emerald-500/10"
        : state === "expired" || state === "failed"
          ? "border-red-500/40 bg-red-500/10"
          : "border-zinc-800 bg-zinc-900";
  const waiting = state === "pending" || state === "review" || state === "matched" || state === "queued";
  return (
    <div role="status" aria-live="polite" className={`rounded-3xl border p-6 ${tone}`}>
      <div aria-hidden className={`text-4xl ${waiting ? "motion-safe:animate-pulse" : ""}`}>
        {icon[state]}
      </div>
      <p className="mt-3 text-lg font-bold text-zinc-50">{label[state]}</p>
      {state === "live" && status?.remainingSec != null && (
        <p className="mt-1 font-mono text-4xl font-black tabular-nums text-brand-300">
          {status.remainingSec}s
          <span className="sr-only"> left</span>
        </p>
      )}
      {status?.message && state !== "failed" && (
        <p className="mt-2 text-sm text-zinc-400">{status.message}</p>
      )}
    </div>
  );
}
