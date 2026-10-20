// Where Stripe returns a streamer who started payout setup from the DESKTOP
// app's wizard (the browser tab Stripe ran in). The wizard polls payout
// status itself, so this page only has to say "go back to the app".

export default function PayoutsDonePage() {
  return (
    <div className="grid h-screen place-items-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        <h1 className="text-2xl font-bold">Stripe setup saved</h1>
        <p className="text-zinc-400">
          You can close this tab and go back to Stream Hijack — it picks up
          your payout status on its own. If Stripe still needs something from
          you, the app will offer to continue.
        </p>
      </div>
    </div>
  );
}
