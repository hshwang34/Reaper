// The streamer's safety surfaces (docs/CONTENT-SAFETY.md S3 + S5), shared by
// the router page (local client) and the hosted dashboard (session client):
//
//   · ReviewPanel     — paid jobs parked for approval: one-tap approve /
//                       decline, with the countdown to auto-decline
//   · ModerationPanel — which classifiers are live, and the decision log
//                       (rejects, reviews, output-guard stops, reports,
//                       takedowns) with a one-click ban for repeat offenders
//
// Both poll: they're small, streamer-only lists, and polling works the same
// through the local bridge and the cloud without a new WS message type.

import { useEffect, useState } from "react";
import type { ModerationEvent, ReviewItem, Settings } from "@rh/shared";
import type { ApiClient, ModerationLog } from "../lib/apiClient.js";

export function ReviewPanel({ client, pending }: { client: ApiClient; pending?: number }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      client
        .reviews()
        .then((r) => alive && setItems(r))
        .catch(() => {});
    void load();
    // Fast while something is waiting (the viewer's tip is on the clock).
    const t = setInterval(load, pending ? 1500 : 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, [client, pending]);

  if (!items.length) return null;

  async function decide(jobId: string, approve: boolean) {
    setBusy(jobId);
    try {
      await client.decideReview(jobId, approve);
      setItems((xs) => xs.filter((x) => x.jobId !== jobId));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-amber-600/60 bg-amber-950/30 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-amber-300">
        Waiting for your approval ({items.length})
      </h3>
      <div className="space-y-3">
        {items.map((it) => {
          const left = Math.max(0, Math.round((it.expiresAt - now) / 1000));
          return (
            <div key={it.jobId} className="flex gap-3 rounded-lg bg-zinc-950/70 p-3">
              {it.imageUrl && (
                <img
                  src={it.imageUrl}
                  alt="viewer reference"
                  className="h-20 w-20 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="text-zinc-400">
                  <span className="font-semibold text-zinc-100">{it.tipper}</span> · $
                  {it.amount} · {it.durationSec}s · <span className="text-amber-300">{it.why}</span>
                </p>
                <p className="mt-1 break-words text-zinc-200">{it.prompt}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    disabled={busy === it.jobId}
                    onClick={() => void decide(it.jobId, true)}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy === it.jobId}
                    onClick={() => void decide(it.jobId, false)}
                    className="rounded bg-zinc-800 px-3 py-1 text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
                  >
                    Decline
                  </button>
                  <span className="ml-auto text-xs text-zinc-500">auto-declines in {left}s</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const VERDICT_TONE: Record<ModerationEvent["verdict"], string> = {
  allow: "text-emerald-400",
  reject: "text-red-400",
  review: "text-amber-300",
  error: "text-orange-400",
  info: "text-sky-300",
};

export function ModerationPanel({
  client,
  settings,
  onBan,
}: {
  client: ApiClient;
  /** Current settings, to show who is already banned. */
  settings?: Settings | null;
  /** Persist a ban (the host owns saving settings). */
  onBan?: (tipper: string) => void;
}) {
  const [log, setLog] = useState<ModerationLog | null>(null);
  const [showAllows, setShowAllows] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      client
        .moderationLog(60)
        .then((l) => alive && setLog(l))
        .catch(() => {});
    void load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client]);

  if (!log) return null;
  const c = log.classifiers;
  const banned = new Set((settings?.bannedViewers ?? []).map((b) => b.toLowerCase()));
  const events = showAllows ? log.events : log.events.filter((e) => e.verdict !== "allow");

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Safety
      </h3>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <Readiness
          label="Viewer text"
          ok={c.textReady}
          detail={c.devMode ? "demo mode — blocklist only" : c.text.join(" → ") || "no classifier key"}
        />
        <Readiness
          label="Viewer photos"
          ok={c.imagesReady}
          detail={c.devMode ? "demo mode — structure checks only" : c.image.join(" → ") || "needs Sightengine"}
        />
      </div>
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
        <input type="checkbox" checked={showAllows} onChange={(e) => setShowAllows(e.target.checked)} />
        show passed checks
      </label>
      <div className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
        {events.length === 0 && <p className="text-zinc-600">Nothing flagged yet.</p>}
        {events.map((e) => (
          <div key={e.id} className="flex items-baseline gap-2 text-zinc-400">
            <span className="shrink-0 text-zinc-600">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={`shrink-0 ${VERDICT_TONE[e.verdict]}`}>{e.stage}:{e.verdict}</span>
            <span className="min-w-0 flex-1 truncate" title={e.reason}>
              {e.source} — {e.reason}
              {e.tipper ? ` (${e.tipper})` : ""}
            </span>
            {onBan && e.tipper && e.verdict === "reject" && !banned.has(e.tipper.toLowerCase()) && (
              <button
                onClick={() => onBan(e.tipper!)}
                className="shrink-0 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-300 hover:bg-red-700"
              >
                ban
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Readiness({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className={`rounded-lg border p-2 ${ok ? "border-emerald-800" : "border-amber-700"}`}>
      <p className={ok ? "text-emerald-400" : "text-amber-300"}>
        {label}: {ok ? "protected" : "off"}
      </p>
      <p className="truncate text-zinc-500" title={detail}>
        {detail}
      </p>
    </div>
  );
}
