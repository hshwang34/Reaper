// Turns whatever a failed request threw (or a server error string) into a
// sentence a viewer can act on — docs/product/BRAND.md §5: what happened + what
// to do, no codes, no blame. Raw "Failed to fetch" / "HTTP 502" text never
// reaches a screen; anything we don't recognise gets the calm fallback.

export const FALLBACK = "Something went wrong on our side. Try again in a moment.";

/** Server messages we know, matched on a lower-cased fragment. Meaning is
 *  preserved word for word where money or safety is involved. */
const KNOWN: Array<[RegExp, string]> = [
  [/too many rejected requests/, "Your recent requests didn't pass the safety checks, so custom ideas and photos are paused for you. Effects from the list still work."],
  [/too many pending submissions/, "You have too many requests waiting. Try again shortly."],
  [/can't submit effects on this stream/, "You can't request effects on this stream."],
  [/isn't available on this stream/, "That effect isn't available on this stream. Pick a different one."],
  [/needs a (clear )?(reference image|photo)/, "That effect needs a photo. Add one and try again."],
  [/custom prompts are disabled/, "This streamer has turned off custom ideas. Pick an effect from the list."],
  [/custom prompts are unavailable/, "Custom ideas aren't available right now. Pick an effect from the list."],
  [/reference images are disabled/, "This streamer has turned off photos."],
  [/photo uploads are unavailable/, "Photos aren't available right now. Try again later or pick an effect without one."],
  [/confirm you have consent/, "Check the consent box. You need permission to put someone's face on stream."],
  [/image too large|too large/, "That photo is too large. Pick a smaller one."],
  [/invalid upload/, "We couldn't read that photo. Pick a different one."],
  [/too many requests/, "You're going a bit fast. Wait a moment and try again."],
  [/effect expired/, "That request expired before you paid. Start again to get a new one."],
  [/isn't running right now|app isn't live/, "The streamer isn't live right now, so payments are paused. Check back when they're streaming."],
  [/paused hijacks/, "The streamer has paused hijacks for now. Try again in a bit."],
  [/hasn't finished setting up payments/, "This streamer hasn't finished setting up payments yet. Check back later."],
  [/minimum is \$/, "That amount is below the minimum. Pick a higher amount."],
  [/maximum is \$/, "That amount is above the maximum. Pick a lower amount."],
  [/unknown channel/, "We couldn't find this streamer's page. Check the link and try again."],
  [/payments aren't configured/, "Payments aren't available right now. Try again later."],
  [/tell us what was wrong/, "Tell us what went wrong so we can look into it."],
  [/contact and description are required/, "Add your email and a short description, then send it again."],
  [/queue is full/, "The queue is full right now. Try again in a bit."],
  [/hijack cancelled|cancelled:/, "The hijack was stopped before it played."],
  [/lost the connection/, "We lost the connection. Check your internet and try again."],
];

/** Does this look like the browser's own network-failure text? */
const NETWORK = /failed to fetch|networkerror|network request failed|load failed|fetch failed|econn|socket/i;

function fromStatus(status: number): string | null {
  if (status === 0) return "We couldn't reach the server. Check your connection and try again.";
  if (status === 401 || status === 403) return "You don't have access to do that.";
  if (status === 404) return "We couldn't find that. Reload the page and try again.";
  if (status === 408 || status === 504) return "That took too long. Try again.";
  if (status === 410) return "That request expired. Start again to get a new one.";
  if (status === 413) return "That photo is too large. Pick a smaller one.";
  if (status === 429) return "You're going a bit fast. Wait a moment and try again.";
  if (status >= 500) return FALLBACK;
  return null;
}

/** `err` may be an Error (ApiError carries `.status`), a server error string, or anything. */
export function friendlyError(err: unknown): string {
  const status = typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : null;
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  const msg = raw.trim().toLowerCase();
  if (err instanceof TypeError || NETWORK.test(msg)) {
    return "We couldn't reach the server. Check your connection and try again.";
  }
  for (const [re, text] of KNOWN) if (re.test(msg)) return text;
  if (status != null) return fromStatus(status) ?? FALLBACK;
  if (/^http \d{3}$/.test(msg)) return fromStatus(Number(msg.slice(5))) ?? FALLBACK;
  return FALLBACK;
}
