// "Get paid" — the streamer's side of viewer payments (server/src/payments.ts).
//
// Viewers pay through Stripe; Stripe sends the streamer their share and keeps
// our fee (Stripe's processing + the GPU seconds + our margin). To receive it
// the streamer needs a Stripe Express account — Stripe hosts the whole
// identity/bank flow, we only store the account id. Until Stripe has
// verified them, their page can't take payments.

import { useEffect, useState } from "react";
import type { ApiClient, PayoutsInfo } from "../lib/api.js";

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

  useEffect(() => {
    client.payouts().then(setInfo).catch((e) => setError((e as Error).message));
  }, [client]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await client.startPayouts(country, from);
      location.href = url; // Stripe-hosted onboarding; returns to /dashboard
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!info) return error ? <p className="text-sm text-red-400">{error}</p> : null;
  if (!info.configured) {
    return <p className="text-sm text-zinc-500">Payments aren't configured on this server (dev mode).</p>;
  }

  const by = (status: string) => info.earnings.find((e) => e.status === status);
  const delivered = by("delivered");
  const waiting = by("paid"); // paid, hijack not played yet (queued / router offline)
  const refunded = by("refunded");
  const review = by("failed_after_start");
  const share = (row?: { gross: number; fees: number }) => (row ? row.gross - row.fees : 0);

  return (
    <div className="space-y-3 text-sm">
      {info.enabled ? (
        <>
          <p className="text-emerald-400">✓ Viewers can pay for hijacks on your page.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Played" value={String(delivered?.n ?? 0)} />
            <Stat
              label="Waiting to play"
              value={String(waiting?.n ?? 0)}
              hint={waiting ? `${usd(share(waiting))} — plays when your app is live` : undefined}
            />
            <Stat label="Your share (played)" value={usd(share(delivered))} hint="before Stripe's card fee" />
            <Stat label="Refunded" value={String(refunded?.n ?? 0)} />
          </div>
          {review && (
            <p className="text-xs text-amber-400">
              {review.n} paid hijack(s) failed after starting — held for review, not refunded automatically.
            </p>
          )}
          <p className="text-xs text-zinc-500">
            Payouts arrive in your Stripe account on Stripe's schedule. A paid
            hijack that never starts is refunded to the viewer automatically.
          </p>
        </>
      ) : (
        <>
          <p className="text-zinc-300">
            {info.started
              ? "Stripe is still verifying your details (or needs something else from you)."
              : "Viewers pay for hijacks on your page; you receive the money through Stripe."}{" "}
            Each payment covers the AI video time and a small platform fee —
            on a $10 hijack you receive about $8.70.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!info.started && (
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="rounded bg-zinc-900 px-2 py-2"
                aria-label="Country you get paid in"
              >
                {PAYOUT_COUNTRIES.map(([c, name]) => (
                  <option key={c} value={c}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => void start()}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 font-semibold hover:bg-indigo-500 disabled:opacity-40"
            >
              {busy ? "Opening Stripe…" : info.started ? "Continue Stripe setup" : "Set up payouts with Stripe"}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-zinc-900 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}
