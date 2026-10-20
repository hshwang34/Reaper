// How a viewer's payment splits. Pure, so the money math is unit-tested.
//
// Stripe Connect DIRECT charge with Managed Risk: the payment is made on the
// streamer's own Stripe account (they are the seller of record), Stripe
// deducts its processing fee from it, and `application_fee_amount` comes to
// us. Stripe — not us — screens fraud and absorbs unrecoverable losses
// (chargebacks on stolen cards), which is why this model was chosen.
//
//   our application fee = GPU cost + platform margin
//   streamer receives   = amount − Stripe's fee − our application fee
//
// $10 for 10s:  20¢ GPU + 50¢ margin (5%) = 70¢ to us; Stripe takes
//               59¢ (2.9% + 30¢) → streamer receives $8.71.
//
// Stripe's fee is estimated at the standard US card rate for the display;
// the real one is whatever Stripe charges the streamer's account. Our fee
// never exceeds the amount.

export interface FeeConfig {
  /** Our cut, % of the payment (after costs are covered). */
  platformFeePct: number;
  /** What one second of lucy-2.5 costs us, in USD. */
  gpuCostPerSec: number;
  /** Stripe's card rate: percentage + fixed cents. */
  stripePct: number;
  stripeFixedCents: number;
}

export const DEFAULT_FEES: FeeConfig = {
  platformFeePct: 5,
  gpuCostPerSec: 0.02,
  stripePct: 2.9,
  stripeFixedCents: 30,
};

export interface PaymentSplit {
  amountCents: number;
  /** Estimated — Stripe deducts the real fee from the streamer's account. */
  stripeFeeCents: number;
  gpuCents: number;
  marginCents: number;
  /** What we receive (`application_fee_amount`). */
  applicationFeeCents: number;
  /** Estimated net to the streamer. */
  streamerCents: number;
}

export function splitPayment(amountCents: number, durationSec: number, cfg: FeeConfig = DEFAULT_FEES): PaymentSplit {
  const stripeFeeCents = Math.round((amountCents * cfg.stripePct) / 100) + cfg.stripeFixedCents;
  // GPU rounds UP: under-charging it is the one error that costs us money.
  const gpuCents = Math.ceil(durationSec * cfg.gpuCostPerSec * 100);
  const marginCents = Math.round((amountCents * cfg.platformFeePct) / 100);
  const applicationFeeCents = Math.min(amountCents, gpuCents + marginCents);
  return {
    amountCents,
    stripeFeeCents,
    gpuCents,
    marginCents,
    applicationFeeCents,
    streamerCents: Math.max(0, amountCents - stripeFeeCents - applicationFeeCents),
  };
}
