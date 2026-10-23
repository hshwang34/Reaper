// Outbound links that are set in one place. Every element marked `data-discord` gets the
// invite as its href; while DISCORD_URL is empty they stay hidden, so the page never shows
// a dead "Join our Discord" button.

export const DISCORD_URL = "";

export function applyLinks(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-discord]")) {
    if (!DISCORD_URL) {
      el.hidden = true;
      continue;
    }
    if (el instanceof HTMLAnchorElement) {
      el.href = DISCORD_URL;
      el.rel = "noopener";
    }
    el.hidden = false;
  }
}
