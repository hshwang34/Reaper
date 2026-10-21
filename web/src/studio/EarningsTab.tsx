// Earnings: is money flowing, and what played. Payout details and history
// beyond the last few hijacks live on the hosted dashboard (one click away);
// the studio only answers "am I set up to get paid, and how's tonight going".

import { useEffect, useState } from "react";
import { api, type LedgerRow } from "../lib/api.js";
import { desktopBridge } from "../lib/desktop.js";
import { TRAY_NAME } from "../lib/platform.js";
import { effectName, hijackReason, hijackResult } from "../lib/streamerCopy.js";
import { PayoutsPanel } from "../dashboard/PayoutsPanel.js";
import { Card, ErrorCard, Skeleton, btn } from "./ui.js";

export function EarningsTab({ cloud }: { cloud: { login: string; portalUrl: string } | null }) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  /** A failed fetch is NOT an empty list: a streamer reads "no hijacks" as "no money". */
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cloud) return;
    setFailed(false);
    api.ledger().then(setRows).catch(() => setFailed(true));
  }, [cloud, attempt]);

  if (!cloud) {
    return (
      <Card title="Earnings">
        <p className="text-sm text-zinc-400">
          This version is an offline demo, so there are no payments. To take paid hijacks, sign in with Twitch: open
          the {TRAY_NAME} and choose Run setup again.
        </p>
      </Card>
    );
  }
  const dashboard = new URL("/dashboard", cloud.portalUrl).toString();
  return (
    <div className="space-y-6">
      <Card
        title="Payouts"
        action={
          <button className={btn.secondary} onClick={() => void desktopBridge()?.openExternal(dashboard)}>
            Open full dashboard ↗
          </button>
        }
      >
        <PayoutsPanel client={api} from="app" />
      </Card>
      <Card title="Recent hijacks">
        {failed ? (
          <ErrorCard message="We couldn't load your earnings. Try again." onRetry={() => setAttempt((n) => n + 1)} />
        ) : rows === null ? (
          <div aria-busy="true" className="space-y-2">
            <p className="text-sm text-zinc-400">Loading hijacks…</p>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-zinc-400">No hijacks yet. Share your hijack page and chat can start paying.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {rows.slice(0, 12).map((r) => {
              const o = hijackResult(r);
              const why = hijackReason(r);
              return (
                <li key={r.jobId} className="flex items-center gap-4 py-3 text-sm">
                  <span className="w-24 shrink-0 text-xs text-zinc-400">
                    {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-zinc-100">{effectName(r.prompt)}</span>
                    <span className="text-zinc-400"> · {r.username || "someone in chat"}</span>
                  </span>
                  <span className="tabular-nums text-zinc-300">
                    {r.amountUsd > 0 ? `$${r.amountUsd}` : "Free test"} · {r.durationSec}s
                  </span>
                  <span className={`w-28 text-right ${o.tone}`}>
                    {o.label}
                    {why && <span className="block text-xs text-zinc-400">{why}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
