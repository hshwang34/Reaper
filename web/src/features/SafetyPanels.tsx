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
    <div className="rounded-2xl border border-amber-500/50 bg-amber-950/30 p-5">
      <h2 className="mb-3 text-base font-semibold text-amber-200">
        Waiting for your OK ({items.length})
      </h2>
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

/** What the streamer is told about a blocked request — never a vendor name
 *  or a stage code. */
const WHAT: Record<ModerationEvent["stage"], string> = {
  text: "Typed idea blocked",
  image: "Photo blocked",
  review: "Declined",
  output: "Effect stopped mid-way",
  report: "Viewer report",
  takedown: "Removal request",
  ban: "Viewer banned",
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
  const events = log.events.filter((e) => e.verdict !== "allow" && e.verdict !== "info").slice(0, 20);

  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
      <h2 className="text-base font-semibold text-zinc-100">Recently blocked</h2>
      {/* Only say something about screening when part of it is down — then
          the matching viewer option is closed (fail closed), and the
          streamer should know why viewers can't use it. */}
      {!c.devMode && (!c.textReady || !c.imagesReady) && (
        <p className="mt-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {!c.textReady && "Typed ideas are paused right now — screening for them is unavailable. "}
          {!c.imagesReady && "Photo uploads are paused right now — screening for them is unavailable. "}
          Gallery effects keep working.
        </p>
      )}
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">Nothing blocked yet. Requests that break your rules show up here.</p>
      ) : (
        <ul className="mt-3 divide-y divide-white/5">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="w-16 shrink-0 text-xs text-zinc-500">
                {new Date(e.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-zinc-100">{WHAT[e.stage]}</span>
                {e.tipper && <span className="text-zinc-400"> · {e.tipper}</span>}
                <span className="block truncate text-xs text-zinc-500" title={e.reason}>
                  {e.reason}
                </span>
              </span>
              {onBan && e.tipper && e.verdict === "reject" && !banned.has(e.tipper.toLowerCase()) && (
                <button
                  onClick={() => onBan(e.tipper!)}
                  className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:border-red-500 hover:text-red-300"
                >
                  Ban
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
