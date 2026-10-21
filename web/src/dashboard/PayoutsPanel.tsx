// "Payouts" — the streamer's side of payments from chat (server/src/payments.ts).
//
// Viewers pay through Stripe; Stripe sends the streamer their share and keeps
// our fee (Stripe's processing + the GPU seconds + our margin). To receive it
// the streamer needs a Stripe Express account — Stripe hosts the whole
// identity/bank flow, we only store the account id. Until Stripe has
// verified them, their page can't take payments.

import { useEffect, useState } from "react";
import type { ApiClient, PayoutsInfo } from "../lib/api.js";
import { desktopBridge } from "../lib/desktop.js";
import { friendlyStreamerError } from "../lib/friendlyError.js";
import { Skeleton, btn } from "../studio/ui.js";

/** Countries where a streamer can open a Stripe account (they sell through
 *  their own account — direct charges). Not exhaustive — the common
 *  streaming markets among Stripe's supported countries. */
export const PAYOUT_COUNTRIES: [string, string][] = [
  ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"],
  ["NZ", "New Zealand"], ["IE", "Ireland"], ["DE", "Germany"], ["FR", "France"],
  ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["BE", "Belgium"],
  ["AT", "Austria"], ["CH", "Switzerland"], ["SE", "Sweden"], ["NO", "Norway"],
  ["DK", "Denmark"], ["FI", "Finland"], ["PL", "Poland"], ["PT", "Portugal"],
  ["JP", "Japan"], ["SG", "Singapore"], ["HK", "Hong Kong"],
  ["MX", "Mexico"], ["BR", "Brazil"],
];

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function PayoutsPanel({ client, from }: { client: ApiClient; from: "app" | "dashboard" }) {
  const [info, setInfo] = useState<PayoutsInfo | null>(null);
  const [country, setCountry] = useState("US");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    client.payouts().then(setInfo).catch((e) => setError(friendlyStreamerError(e)));
  }, [client, attempt]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await client.startPayouts(country, from);
      // Stripe-hosted onboarding. The desktop app opens it in the system
      // browser (its window only ever shows our own pages); it returns to
      // /payouts-done, and this panel re-reads on the next visit.
      const desktop = desktopBridge();
      if (desktop) {
        await desktop.openExternal(url);
        setBusy(false);
      } else {
        location.href = url; // returns to /dashboard
      }
    } catch (e) {
      setError(friendlyStreamerError(e));
      setBusy(false);
    }
  }

  if (!info) {
    return error ? (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-300">
        <p>{error}</p>
        <button type="button" className={btn.secondary} onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    ) : (
      <div aria-busy="true" className="space-y-2">
        <p className="text-sm text-zinc-400">Loading payouts…</p>
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (!info.configured) {
    return <p className="text-sm text-zinc-400">Payments aren't available in this version.</p>;
  }

  const by = (status: string) => info.earnings.find((e) => e.status === status);
  const delivered = by("delivered");
  const waiting = by("paid"); // paid, hijack not played yet (in line, or the studio is off)
  const refunded = by("refunded");
  const review = by("failed_after_start");
  const share = (row?: { gross: number; fees: number }) => (row ? row.gross - row.fees : 0);

  return (
    <div className="space-y-3 text-sm">
      {info.enabled ? (
        <>
          <p className="text-emerald-400">Chat can pay for hijacks on your page.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Played" value={String(delivered?.n ?? 0)} />
            <Stat
              label="Waiting to play"
              value={String(waiting?.n ?? 0)}
              hint={waiting ? `${usd(share(waiting))}. Plays when you turn on Stream Hijack.` : undefined}
            />
            <Stat label="Your share (played)" value={usd(share(delivered))} hint="before Stripe's card fee" />
            <Stat label="Refunded" value={String(refunded?.n ?? 0)} />
          </div>
          {review && (
            <p className="text-sm text-amber-300">
              {review.n} paid {review.n === 1 ? "hijack" : "hijacks"} stopped partway. They're held for review, and
              chat wasn't refunded automatically.
            </p>
          )}
          <p className="text-sm text-zinc-400">
            Payouts arrive in your Stripe account on Stripe's schedule. A paid hijack that never starts is refunded
            to the person who paid, automatically.
          </p>
        </>
      ) : (
        <>
          <p className="text-zinc-300">
            {info.started
              ? "Stripe is still checking your details, or it needs something more from you."
              : "Chat pays for hijacks on your page. You get paid through Stripe."}{" "}
            Each payment covers the AI time and our fee (the AI time plus 5%), before Stripe's card fee. On a $10
            hijack you receive about $8.70.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!info.started && (
              <label className="flex items-center gap-2 text-zinc-300">
                Country
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="min-h-11 rounded-lg bg-zinc-900 px-3"
                  aria-label="Country you get paid in"
                >
                  {PAYOUT_COUNTRIES.map(([c, name]) => (
                    <option key={c} value={c}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              onClick={() => void start()}
              disabled={busy}
              className={btn.primary}
            >
              {busy ? "Opening Stripe…" : info.started ? "Continue Stripe setup" : "Set up payouts with Stripe"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-zinc-900 p-3">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}
