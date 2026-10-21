// Earnings: is money flowing, and what played. Payout details and history
// beyond the last few hijacks live on the hosted dashboard (one click away);
// the studio only answers "am I set up to get paid, and how's tonight going".

import { useEffect, useState } from "react";
import { PRESETS } from "@rh/shared";
import { api, type LedgerRow } from "../lib/api.js";
import { desktopBridge } from "../lib/desktop.js";
import { PayoutsPanel } from "../dashboard/PayoutsPanel.js";
import { Card, btn } from "./ui.js";

const OUTCOME: Record<string, { label: string; tone: string }> = {
  completed: { label: "Played", tone: "text-emerald-300" },
  failed: { label: "Didn't play", tone: "text-red-300" },
  dispatched: { label: "In progress", tone: "text-amber-200" },
};

/** The ledger stores the prompt; show the effect's name when it's a preset. */
function effectName(prompt: string): string {
  return PRESETS.find((p) => p.prompt === prompt)?.label ?? "Typed idea";
}

export function EarningsTab({ cloud }: { cloud: { login: string; portalUrl: string } | null }) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  useEffect(() => {
    if (!cloud) return;
    api.ledger().then(setRows).catch(() => setRows([]));
  }, [cloud]);

  if (!cloud) {
    return (
      <Card title="Earnings">
        <p className="text-sm text-zinc-400">
          This copy of Stream Hijack runs as an offline demo, so there are no viewer payments. Sign in with Twitch
          (tray menu → Run setup again) to take paid hijacks.
        </p>
      </Card>
    );
  }
  const dashboard = new URL("/dashboard", cloud.portalUrl).toString();
  return (
    <div className="space-y-6">
      <Card
        title="Getting paid"
        action={
          <button className={btn.secondary} onClick={() => void desktopBridge()?.openExternal(dashboard)}>
            Open full dashboard ↗
          </button>
        }
      >
        <PayoutsPanel client={api} from="app" />
      </Card>
      <Card title="Recent hijacks">
        {rows === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-zinc-400">No hijacks yet. Share your link in chat to get the first one.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {rows.slice(0, 12).map((r) => {
              const o = OUTCOME[r.outcome] ?? { label: r.outcome, tone: "text-zinc-400" };
              return (
                <li key={r.jobId} className="flex items-center gap-4 py-3 text-sm">
                  <span className="w-24 shrink-0 text-xs text-zinc-500">
                    {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-zinc-100">{effectName(r.prompt)}</span>
                    <span className="text-zinc-400"> · {r.username || "viewer"}</span>
                  </span>
                  <span className="text-zinc-300">
                    {r.amountUsd > 0 ? `$${r.amountUsd}` : "Free preview"} · {r.durationSec}s
                  </span>
                  <span className={`w-24 text-right ${o.tone}`}>{o.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
