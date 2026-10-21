// The streamer's safety surfaces (docs/CONTENT-SAFETY.md S3 + S5), shared by
// the studio (local client) and the hosted dashboard (session client):
//
//   · ReviewPanel     — paid jobs parked for approval: one-tap approve /
//                       decline (decline confirms: it refunds), with the
//                       countdown to auto-decline
//   · ModerationPanel — which safety checks are live, and the decision log
//                       (rejects, reviews, live-safety-check stops, reports,
//                       takedowns) with a one-tap ban (and undo) for repeat offenders
//
// Both poll: they're small, streamer-only lists, and polling works the same
// through the local bridge and the cloud without a new WS message type.

import { useEffect, useState } from "react";
import type { ModerationEvent, ReviewItem, Settings } from "@rh/shared";
import type { ApiClient, ModerationLog } from "../lib/apiClient.js";
import { friendlyStreamerError } from "../lib/friendlyError.js";
import { BLOCKED_WHAT, blockedDetail, reviewWhy } from "../lib/streamerCopy.js";
import { ErrorCard, Skeleton, UndoToast, btn, useUndo } from "../studio/ui.js";

export function ReviewPanel({ client, pending }: { client: ApiClient; pending?: number }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  /** The row whose Decline is awaiting its "refund?" confirm. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failed, setFailed] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      client
        .reviews()
        .then((r) => {
          if (!alive) return;
          setItems(r);
          setFailed(0);
        })
        .catch(() => alive && setFailed((n) => n + 1));
    void load();
    // Fast while something is waiting (the viewer's payment is on the clock).
    const t = setInterval(load, pending ? 1500 : 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(clock);
    };
  }, [client, pending]);

  // An empty inbox renders nothing. A failing one must not look empty: a
  // paying viewer may be waiting — but one blip while polling isn't news.
  if (!items.length) {
    return failed >= 2 ? (
      <ErrorCard message="We can't check for requests waiting for your OK right now. We'll keep trying." />
    ) : null;
  }

  async function decide(jobId: string, approve: boolean) {
    setBusy(jobId);
    setActionError(null);
    try {
      await client.decideReview(jobId, approve);
      setItems((xs) => xs.filter((x) => x.jobId !== jobId));
    } catch (e) {
      setActionError(friendlyStreamerError(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  return (
    <div className="rounded-2xl border border-amber-500/50 bg-amber-950/30 p-5">
      <h2 className="mb-3 text-base font-semibold text-amber-200">
        Waiting for your OK ({items.length})
      </h2>
      {actionError && (
        <p role="alert" className="mb-3 text-sm text-red-300">
          {actionError}
        </p>
      )}
      <div className="space-y-3">
        {items.map((it) => {
          const left = Math.max(0, Math.round((it.expiresAt - now) / 1000));
          const paid = it.amount > 0;
          return (
            <div key={it.jobId} className="flex gap-3 rounded-lg bg-zinc-950/70 p-3">
              {it.imageUrl && (
                <img src={it.imageUrl} alt="Photo from chat" className="h-20 w-20 shrink-0 rounded object-cover" />
              )}
              <div className="min-w-0 flex-1 text-sm">
                <p className="text-zinc-400">
                  <span className="font-semibold text-zinc-100">{it.tipper}</span> · ${it.amount} · {it.durationSec}{" "}
                  seconds · <span className="text-amber-300">{reviewWhy(it.why)}</span>
                </p>
                <p className="mt-1 break-words text-zinc-200">{it.prompt}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {confirming === it.jobId && paid ? (
                    <>
                      <span className="text-sm text-zinc-200">Decline and refund ${it.amount}?</span>
                      <button
                        disabled={busy === it.jobId}
                        onClick={() => void decide(it.jobId, false)}
                        className={btn.danger}
                      >
                        Decline
                      </button>
                      <button onClick={() => setConfirming(null)} className={btn.ghost}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        disabled={busy === it.jobId}
                        onClick={() => void decide(it.jobId, true)}
                        className="inline-flex min-h-11 items-center rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        disabled={busy === it.jobId}
                        onClick={() => (paid ? setConfirming(it.jobId) : void decide(it.jobId, false))}
                        className="inline-flex min-h-11 items-center rounded-lg bg-zinc-800 px-4 text-sm font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                      >
                        Decline
                      </button>
                    </>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-zinc-400">auto-declines in {left}s</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The streamer-facing name for each kind of blocked request lives in
 *  streamerCopy.ts (BLOCKED_WHAT) — never a vendor name or a stage code. */

/**
 * The Recently blocked rows. Pure, so a test can render it with hostile
 * input: the line under each row is a friendly category (blockedDetail),
 * never the event's raw `reason` (which can read "suspected CSAM — runbook").
 */
export function BlockedList({
  events,
  banned,
  onBan,
}: {
  events: ModerationEvent[];
  banned: Set<string>;
  onBan?: (name: string) => void;
}) {
  return (
    <ul className="mt-3 divide-y divide-white/5">
      {events.map((e) => {
        const detail = blockedDetail(e);
        return (
          <li key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
            <span className="w-16 shrink-0 text-xs text-zinc-400">
              {new Date(e.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-zinc-100">{BLOCKED_WHAT[e.stage]}</span>
              {e.tipper && <span className="text-zinc-400"> · {e.tipper}</span>}
              {detail && <span className="block truncate text-sm text-zinc-400">{detail}</span>}
            </span>
            {onBan && e.tipper && e.verdict === "reject" && !banned.has(e.tipper.toLowerCase()) && (
              <button
                onClick={() => onBan(e.tipper!)}
                className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-white/10 px-3 text-sm text-zinc-300 hover:border-red-500 hover:text-red-300"
              >
                Ban {e.tipper}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ModerationPanel({
  client,
  settings,
  onBan,
  onUnban,
}: {
  client: ApiClient;
  /** Current settings, to show who is already banned. */
  settings?: Settings | null;
  /** Persist a ban (the host owns saving settings). */
  onBan?: (name: string) => void;
  /** Take a ban back — powers the 6-second Undo after Ban. */
  onUnban?: (name: string) => void;
}) {
  const [log, setLog] = useState<ModerationLog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { undo, offer, clear } = useUndo();

  useEffect(() => {
    let alive = true;
    const load = () =>
      client
        .moderationLog(60)
        .then((l) => {
          if (!alive) return;
          setLog(l);
          setLoadError(false);
        })
        .catch(() => alive && setLoadError(true));
    void load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, attempt]);

  if (!log) {
    return (
      <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5" aria-busy={!loadError}>
        <h2 className="text-base font-semibold text-zinc-100">Recently blocked</h2>
        {loadError ? (
          <div className="mt-3">
            <ErrorCard message="We couldn't load what was blocked. Try again." onRetry={() => setAttempt((n) => n + 1)} />
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-zinc-400">Loading what was blocked…</p>
            <Skeleton className="h-10" />
          </div>
        )}
      </section>
    );
  }
  const c = log.classifiers;
  const banned = new Set((settings?.bannedViewers ?? []).map((b) => b.toLowerCase()));
  const events = log.events.filter((e) => e.verdict !== "allow" && e.verdict !== "info").slice(0, 20);
  const ban = onBan
    ? (name: string) => {
        onBan(name);
        if (onUnban) offer(`Banned ${name}.`, () => onUnban(name));
      }
    : undefined;

  return (
    <section className="rounded-2xl border border-white/10 bg-zinc-950/70 p-5">
      <h2 className="text-base font-semibold text-zinc-100">Recently blocked</h2>
      {/* Only say something when part of our safety checks is down — then the
          matching option is closed (fail closed), and the streamer should
          know why chat can't use it. */}
      {!c.devMode && (!c.textReady || !c.imagesReady) && (
        <p className="mt-3 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {!c.textReady && "Custom effects are paused. Our safety checks can't run right now. "}
          {!c.imagesReady && "Photos are paused for the same reason. "}
          Your list of effects still works.
        </p>
      )}
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-400">Nothing blocked yet. Requests that break your rules show up here.</p>
      ) : (
        <BlockedList events={events} banned={banned} onBan={ban} />
      )}
      <UndoToast undo={undo} onClose={clear} />
    </section>
  );
}
