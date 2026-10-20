// How a viewer's payment splits. Pure, so the money math is unit-tested.
//
// Stripe Connect destination charge: the viewer pays the full amount to the
// platform's Stripe balance, Stripe immediately transfers everything except
// `application_fee_amount` to the streamer's connected account. With
// destination charges the PLATFORM pays Stripe's processing fee, so our
// application fee has to carry it, on top of the GPU seconds and our margin:
//
//   application fee = Stripe fee + GPU cost + platform margin
//   streamer gets   = amount − application fee
//
// $10 for 10s:  59¢ Stripe (2.9% + 30¢) + 20¢ GPU + 50¢ margin (5%)
//               = $1.29 fee → streamer receives $8.71.
//
// Stripe's fee is estimated at the standard US card rate; international and
// currency-converted cards cost more, and that difference comes out of the
// margin. Never negative for the streamer: the fee is capped at the amount.

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
  stripeFeeCents: number;
  gpuCents: number;
  marginCents: number;
  /** What Stripe keeps for the platform (`application_fee_amount`). */
  applicationFeeCents: number;
  streamerCents: number;
}

export function splitPayment(amountCents: number, durationSec: number, cfg: FeeConfig = DEFAULT_FEES): PaymentSplit {
  const stripeFeeCents = Math.round((amountCents * cfg.stripePct) / 100) + cfg.stripeFixedCents;
  // GPU rounds UP: under-charging it is the one error that costs us money.
  const gpuCents = Math.ceil(durationSec * cfg.gpuCostPerSec * 100);
  const marginCents = Math.round((amountCents * cfg.platformFeePct) / 100);
  const applicationFeeCents = Math.min(amountCents, stripeFeeCents + gpuCents + marginCents);
  return {
    amountCents,
    stripeFeeCents,
    gpuCents,
    marginCents,
    applicationFeeCents,
    streamerCents: amountCents - applicationFeeCents,
  };
}
