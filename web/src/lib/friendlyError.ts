// Turns whatever a failed request threw (or a server error string) into a
// sentence a viewer can act on — docs/product/BRAND.md §5: what happened + what
// to do, no codes, no blame. Raw "Failed to fetch" / "HTTP 502" text never
// reaches a screen; anything we don't recognise gets the calm fallback.

export const FALLBACK = "Something went wrong on our side. Try again in a moment.";
const TOO_LARGE = "That photo is over 25 MB. Pick a smaller one."; // client-side pick limit
// The SERVER's upload cap is 5 MB (server/src/index.ts, sidecar/src/uploads.ts) — a 413
// from it is a different number from the 25 MB pre-resize limit above.
const TOO_LARGE_SERVER = "That photo is over 5 MB. Pick a smaller one.";

/** Server messages we know, matched on a lower-cased fragment. Meaning is
 *  preserved word for word where money or safety is involved. */
const KNOWN: Array<[RegExp, string]> = [
  // Engine messages for a hijack that ended early (core/src/engine.ts). The
  // streamer-facing ones read fine as written, so they pass through verbatim —
  // they must NOT fall to the generic fallback.
  [/stopped by the stream'?s? safety|stopped by the streamer's safety/, "It was stopped by the streamer's safety checks."],
  [/declined this effect/, "The streamer declined this effect."],
  [/didn't approve this effect in time/, "The streamer didn't approve this effect in time."],
  [/too many effects waiting for approval|approval queue is full/, "The streamer has too many effects waiting for approval. Try again in a minute."],
  [/^hijack failed/, "It didn't play."],
  [/^hijack cancelled|cancelled:/, "It was cancelled before it played."],
  [/line is full|queue is full/, "The line is full right now. Try again in a minute."],
  [/no checkout url|payment provider error/, "We couldn't start checkout. Try again."],
  [/^something went wrong/, FALLBACK],
  [/too many rejected requests/, "Your recent requests didn't pass the safety checks, so custom ideas and photos are paused for you. Effects from the list still work."],
  [/too many pending submissions/, "You have too many requests waiting. Try again shortly."],
  [/can't submit effects on this stream/, "You can't request effects on this stream."],
  [/isn't available on this stream/, "That effect isn't available on this stream. Pick a different one."],
  [/effect doesn't exist|unknown preset/, "That effect doesn't exist. Pick a different one."],
  [/pick an effect or describe|provide a preset or a custom prompt/, "Pick an effect or describe your own."],
  [/needs a (clear )?(reference image|photo)/, "That effect needs a photo. Add one and try again."],
  [/custom effects are off on this stream|custom prompts are disabled/, "This streamer has turned off custom ideas. Pick an effect from the list."],
  [/custom effects are off right now|custom prompts are unavailable/, "Custom ideas aren't available right now. Pick an effect from the list."],
  [/photos are off on this stream|reference images are disabled/, "This streamer has turned off photos."],
  [/photo uploads are unavailable/, "Photos aren't available right now. Try again later or pick an effect without one."],
  [/confirm you have consent/, "Check the consent box. You need permission to put someone's face on stream."],
  [/over 25 mb/, TOO_LARGE],
  [/over 5 mb|image too large|too large/, TOO_LARGE_SERVER],
  [/invalid upload/, "We couldn't read that photo. Pick a different one."],
  [/too many requests/, "You're going a bit fast. Wait a moment and try again."],
  [/effect expired/, "That request expired before you paid. Start again to get a new one."],
  [/isn't live right now|isn't running right now|app isn't live/, "The streamer isn't live right now, so payments are paused. Check back when they're streaming."],
  [/paused hijacks/, "The streamer has paused hijacks for now. Try again in a bit."],
  [/hasn't finished setting up payments/, "This streamer hasn't finished setting up payments yet. Check back later."],
  [/minimum is \$/, "That amount is below the minimum. Pick a higher amount."],
  [/maximum is \$/, "That amount is above the maximum. Pick a lower amount."],
  [/unknown channel/, "We couldn't find this streamer's page. Check the link and try again."],
  [/payments aren't configured/, "Payments aren't available right now. Try again later."],
  [/tell us what was wrong/, "Tell us what went wrong so we can look into it."],
  [/contact and description are required/, "Add your email and a short description, then send it again."],
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
  if (status === 413) return TOO_LARGE_SERVER;
  if (status === 429) return "You're going a bit fast. Wait a moment and try again.";
  if (status >= 500) return FALLBACK;
  return null;
}

/** `err` may be an Error (ApiError carries `.status`), a server error string, or anything. */
export function friendlyError(err: unknown): string {
  const status = typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : null;
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  const msg = raw.trim().toLowerCase();
  // An output-guard stop (`job:done` reason "safety:…") is the streamer's rules
  // at work, not a fault on our side: say so calmly, without blame.
  if (msg.startsWith("safety:")) return "It was stopped by the streamer's safety checks.";
  if (err instanceof TypeError || NETWORK.test(msg)) {
    return "We couldn't reach the server. Check your connection and try again.";
  }
  for (const [re, text] of KNOWN) if (re.test(msg)) return text;
  if (status != null) return fromStatus(status) ?? FALLBACK;
  if (/^http \d{3}$/.test(msg)) return fromStatus(Number(msg.slice(5))) ?? FALLBACK;
  return FALLBACK;
}

// ── Streamer surfaces ──────────────────────────────────────────────────────
// The wizard, studio and dashboard see a second kind of raw text: Electron IPC
// wrappers, main-process errors, camera DOMExceptions and engine outcomes such
// as "queued (10s, manual)". Same rule — none of it reaches a screen. Streamer
// copy speaks to "you", not "the streamer".

/** An error thrown in the main process, minus Electron's IPC wrapper
 *  ("Error invoking remote method 'rh:…': Error: "). */
export function ipcMessage(e: unknown): string {
  const m = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").trim();
}

const STREAMER_KNOWN: Array<[RegExp, string]> = [
  // Camera permission / device failures (getUserMedia DOMExceptions).
  [/notallowederror|permission denied|permission dismissed/, "Camera access was blocked. Allow it in System Settings and try again."],
  [/notfounderror|requested device not found|devicesnotfound/, "No camera found. Start OBS's Virtual Camera first."],
  [/notreadableerror|could not start video source|trackstarterror/, "Couldn't open the camera. Check that nothing else is using it, then try again."],
  // Plain strings the desktop app's main process produces on purpose.
  [/couldn't find obs|obs isn't in its default install location/, "We couldn't find OBS. Open it yourself and we'll connect."],
  [/sign in with twitch to set up payouts/, "Sign in with Twitch to set up payouts."],
  [/sign-in expired|sign in again/, "Your sign-in expired. Sign in again."],
  [/still connecting/, "Still connecting…"],
  // Engine outcomes from a studio test / manual tip (core/src/engine.ts).
  [/^ignored: below min tip \(\$?([\d.]+)\)/, "That's below your minimum."],
  [/review backlog full/, "Too many requests are waiting for your OK."],
  [/^parked for streamer approval/, "Waiting for your OK."],
  [/^dropped: queue full/, "The line is full. Try again in a moment."],
  [/^queued \(/, "Starting…"],
  [/no such pending review/, "That request is gone. It may have expired."],
  [/free test hijack is used/, "You've used today's free test. It resets at midnight UTC."],
  [/country must be a 2-letter code/, "Pick the country your bank is in."],
  [/payments aren't configured/, "Payments aren't available right now."],
];

/** Like friendlyError, for streamer-facing screens. Handles IPC failures,
 *  `HTTP 5xx`, camera DOMExceptions and engine outcome strings; everything
 *  else falls through to the viewer mapper (and its calm fallback). */
export function friendlyStreamerError(err: unknown): string {
  const name = typeof (err as { name?: unknown } | null)?.name === "string" ? (err as { name: string }).name : "";
  const raw = ipcMessage(err);
  const hay = `${name} ${raw}`.trim().toLowerCase();
  for (const [re, text] of STREAMER_KNOWN) {
    if (re.test(hay) || re.test(raw.toLowerCase())) return text;
  }
  const status = typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : null;
  const http = /^http (\d{3})$/.exec(raw.toLowerCase());
  const code = status ?? (http ? Number(http[1]) : null);
  if (code != null && code >= 500) return "The server isn't answering. Try again in a moment.";
  // Hand the unwrapped text on, keeping any status so the code-based mapping still applies.
  return friendlyError(raw && err instanceof Error ? Object.assign(new Error(raw), status != null ? { status } : {}) : err);
}
