/// <reference types="vite/client" />
// The "Join the waitlist" form. Posts to the control plane's public
// /api/waitlist (server/src/waitlist.ts), which allows this site's origin.
// No Discord link ever appears here: approved streamers get a single-use
// invite by email, so applicants never see the server's member count.

const API = (import.meta.env.VITE_WAITLIST_API as string | undefined) ?? "https://app.streamhijack.com";

export function initWaitlist(): void {
  const form = document.getElementById("waitlist") as HTMLFormElement | null;
  const status = document.getElementById("waitlistStatus");
  if (!form || !status) return;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;

  const say = (text: string, state: "error" | "done" | "busy" | "") => {
    status.textContent = text;
    status.dataset.state = state;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Native validity for the required fields; mark the first bad one.
    const fields = Array.from(form.querySelectorAll<HTMLInputElement>("input, select"));
    fields.forEach((el) => el.removeAttribute("aria-invalid"));
    const bad = fields.find((el) => !el.checkValidity());
    if (bad) {
      bad.setAttribute("aria-invalid", "true");
      bad.focus();
      say(bad.name === "email" ? "Enter a valid email address." : "Fill in the highlighted field.", "error");
      return;
    }

    const body = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    say("Adding you…", "busy");
    try {
      const res = await fetch(`${API}/api/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        fields.forEach((el) => (el.disabled = true));
        button.textContent = "You’re on the list";
        say("Watch your inbox. Invites go out in small batches.", "done");
        return;
      }
      const msg =
        res.status === 429
          ? "Too many tries. Give it a minute."
          : ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      say(msg || "Something went wrong. Try again, or email hello@streamhijack.com.", "error");
    } catch {
      say("Couldn’t reach us. Check your connection, or email hello@streamhijack.com.", "error");
    }
    button.disabled = false;
  });
}
