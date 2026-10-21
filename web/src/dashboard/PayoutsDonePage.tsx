// Where Stripe returns a streamer who started payout setup from the DESKTOP
// app's wizard (the browser tab Stripe ran in). The wizard polls payout
// status itself, so this page only has to say "go back to the app".

export default function PayoutsDonePage() {
  return (
    <div className="grid h-screen place-items-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        <h1 className="text-2xl font-bold">Back to Stream Hijack</h1>
        <p className="text-zinc-300">
          Close this tab and go back to the app. We'll check your payout status. If Stripe needs more from you, the
          app will say so.
        </p>
      </div>
    </div>
  );
}
