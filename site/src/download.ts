// The download page. The button is a plain link to GitHub's stable "latest release" URL, so
// it works with no JavaScript. This adds what a link can't know:
// - the live version, date, size and checksum (GitHub's releases API, 60 requests/hour per
//   visitor IP: if it fails, the static text and the link stay as they are);
// - a disabled "First build lands soon" state while no release is published, so the button
//   never leads to a 404;
// - a note for visitors on Windows, Linux or a phone, with a way to send the link to their Mac.
import "./style.css";
import "./product.css";
import "./trust.css";
import "./download.css";
import { applyLinks } from "./links";

applyLinks();

const REPO = "hshwang34/Reaper";
const ASSET = "Stream-Hijack-mac.dmg"; // fixed by artifactName in app/electron-builder.yml
const PAGE = "https://streamhijack.com/download";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

/* ---------- who's visiting ---------- */

type Platform = "mac" | "windows" | "linux" | "phone";

function detect(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  const ua = navigator.userAgent;
  const hint = nav.userAgentData?.platform ?? "";
  if (nav.userAgentData?.mobile || /iPhone|iPod|Android/i.test(ua)) return "phone";
  // iPadOS asks for desktop sites and says it's a Mac; the touch screen gives it away
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "phone";
  if (/Windows/i.test(hint) || /Windows/.test(ua)) return "windows";
  if (/Linux|Chrome OS|CrOS/i.test(`${hint} ${ua}`)) return "linux";
  return "mac";
}

const NOTICES: Record<Exclude<Platform, "mac">, string> = {
  windows: "<b>You’re on Windows.</b> The beta is Mac only for now, and Windows is next. Streaming from a Mac too? Send yourself the link.",
  linux: "<b>Stream Hijack runs on macOS.</b> Linux isn’t supported. Streaming from a Mac? Send yourself the link.",
  phone: "<b>Stream Hijack runs on the Mac you stream from.</b> Send yourself the link and open it there.",
};

const platform = detect();
document.documentElement.dataset.platform = platform;
if (platform !== "mac") {
  // the Mac button stays: detection is only a hint (a Mac can send a Windows user agent)
  $("dlNoticeText").innerHTML = NOTICES[platform];
  $("dlNotice").hidden = false;
}

const copy = $<HTMLButtonElement>("dlCopy");
copy.addEventListener("click", async () => {
  const shareable = platform === "phone" && typeof navigator.share === "function";
  try {
    if (shareable) await navigator.share({ title: "Stream Hijack for Mac", url: PAGE });
    else {
      await navigator.clipboard.writeText(PAGE);
      copy.textContent = "Link copied";
      setTimeout(() => (copy.textContent = "Copy the download link"), 2500);
    }
  } catch {
    // share sheet dismissed, or no clipboard access: show the link to copy by hand
    if (!shareable) copy.textContent = PAGE;
  }
});
if (platform === "phone" && typeof navigator.share === "function") copy.textContent = "Send the link to my Mac";

/* ---------- the latest release ---------- */

interface Asset {
  name: string;
  size: number;
  digest?: string | null; // "sha256:…" on newer releases
}
interface Release {
  tag_name: string;
  published_at: string;
  html_url: string;
  assets: Asset[];
}

function noRelease(): void {
  const btn = $<HTMLAnchorElement>("dlBtn");
  btn.removeAttribute("href");
  btn.setAttribute("aria-disabled", "true");
  $("dlLabel").textContent = "First build lands soon";
  $("dlVersion").textContent = "We’re finishing the signed build. Check back shortly.";
  $("dlNotes").hidden = true;
}

async function loadRelease(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    return; // offline or blocked: the static text and the stable link still work
  }
  if (res.status === 404) return noRelease(); // nothing published yet
  if (!res.ok) return; // rate-limited or GitHub trouble: keep the static text
  const r = (await res.json()) as Release;
  const dmg = r.assets.find((a) => a.name === ASSET);
  if (!dmg) return noRelease(); // a release without the Mac build can't be downloaded either

  const date = new Date(r.published_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  $("dlVersion").textContent = `Version ${r.tag_name.replace(/^v/, "")} · ${date}`;
  const size = $("dlSize");
  size.textContent = `${Math.round(dmg.size / 1e6)} MB`;
  size.hidden = false;
  $<HTMLAnchorElement>("dlNotes").href = r.html_url;
  const sha = dmg.digest?.startsWith("sha256:") ? dmg.digest.slice(7) : "";
  if (sha) {
    $("dlSha").textContent = sha;
    $("dlCheck").hidden = false;
  }
}

void loadRelease();
