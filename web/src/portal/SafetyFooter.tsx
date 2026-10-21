import { useState } from "react";
import { api } from "../lib/api.js";

/** Report + removal request (CONTENT-SAFETY S5). Both land in the streamer's
 *  moderation log; a removal request naming an image URL acts immediately,
 *  and the 48-hour clock (TAKE IT DOWN Act) starts at submission. */
export function SafetyFooter({ code }: { code: string | null }) {
  const [open, setOpen] = useState<null | "report" | "takedown">(null);
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setErr(null);
    try {
      if (open === "report") {
        await api.report(text.trim(), code ? { code } : {});
        setDone("Thanks — the streamer's moderation log has your report.");
      } else {
        const r = await api.takedown({
          contact: contact.trim(),
          description: text.trim(),
          imageUrl: imageUrl.trim() || undefined,
        });
        setDone(
          `Request ${r.ticket.slice(0, 8)} received${r.removed ? ` — ${r.removed} file(s) removed now` : ""}. We act on removal requests within 48 hours.`,
        );
      }
      setOpen(null);
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const field =
    "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-brand-400 focus:outline-none";

  return (
    <footer className="mt-12 border-t border-zinc-800/80 pt-5 text-center text-sm text-zinc-400">
      {done && <p className="mb-3 text-emerald-400">{done}</p>}
      {!open ? (
        <p className="flex flex-wrap justify-center gap-x-6">
          <button type="button" className="min-h-11 underline-offset-4 hover:text-zinc-100 hover:underline" onClick={() => setOpen("report")}>
            Report a problem
          </button>
          <button type="button" className="min-h-11 underline-offset-4 hover:text-zinc-100 hover:underline" onClick={() => setOpen("takedown")}>
            Request removal of an image of you
          </button>
        </p>
      ) : (
        <div className="mx-auto max-w-lg space-y-2 text-left">
          <p className="font-semibold text-zinc-200">
            {open === "report" ? "Report a problem" : "Request removal of an image of you"}
          </p>
          {open === "takedown" && (
            <>
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                aria-label="Your email"
                placeholder="How we can reach you (email)"
                className={field}
              />
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                aria-label="Image link"
                placeholder="Image link, if you have it (optional)"
                className={field}
              />
            </>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            aria-label={open === "report" ? "What was wrong" : "What should be removed"}
            placeholder={open === "report" ? "What was wrong?" : "What should be removed, and when you saw it"}
            className={field}
          />
          {err && <p className="text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="min-h-11 px-4 text-zinc-400 hover:text-zinc-100" onClick={() => setOpen(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="min-h-11 rounded-xl bg-zinc-800 px-5 font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-40"
              disabled={!text.trim() || (open === "takedown" && !contact.trim())}
              onClick={() => void send()}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}
