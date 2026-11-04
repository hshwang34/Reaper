#!/usr/bin/env node
// Waitlist admin — review signups and approve them into the creator Discord:
//
//   npm run waitlist                       # pending signups, oldest first
//   npm run waitlist -- list all           # every status (pending|invited|declined|all)
//   npm run waitlist -- invite <id|email>… # mint single-use invites + open the emails
//   npm run waitlist -- decline <id|email>
//
// Talks to the control plane's admin API (server/src/waitlist.ts) with
// RH_ADMIN_TOKEN from the environment or the repo .env. RH_WAITLIST_URL
// overrides the target (default production; http://127.0.0.1:8790 for dev).
//
// `invite` does NOT send mail. It opens a pre-filled Gmail draft as
// hello@streamhijack.com for each approval — a new domain earns its sender
// reputation one hand-sent email at a time (docs/DOMAIN-AND-EMAIL.md §5).

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** RH_* from the environment first, then the repo .env (no dotenv dep at the root). */
function setting(name) {
  if (process.env[name]) return process.env[name].trim();
  const file = resolve(repoRoot, ".env");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}

const BASE = (setting("RH_WAITLIST_URL") || "https://app.streamhijack.com").replace(/\/+$/, "");
const TOKEN = setting("RH_ADMIN_TOKEN");
const SENDER = "hello@streamhijack.com";

async function api(path, method = "GET") {
  const res = await fetch(`${BASE}/api/admin/waitlist${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path || "/"} → ${res.status} ${body.error ?? ""}`);
  return body;
}

const VIEWERS = { "under-10": "<10", "10-50": "10–50", "50-200": "50–200", "200-plus": "200+" };
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function list(status = "pending") {
  const { signups } = await api(status === "all" ? "" : `?status=${encodeURIComponent(status)}`);
  if (!signups.length) return console.log(`no ${status === "all" ? "" : status + " "}signups`);
  for (const s of signups.reverse()) {
    console.log(
      `${s.id.slice(0, 8)}  ${day(s.createdAt)}  ${s.status.padEnd(8)}  ${(VIEWERS[s.viewers] ?? s.viewers).padEnd(6)}  ${s.email}  ${s.channel}`,
    );
    if (s.idea) console.log(`          “${s.idea}”`);
  }
  console.log(`\n${signups.length} ${status}`);
}

/** Accept a full id, an 8-char id prefix (as `list` prints), or the email. */
async function resolveId(ref) {
  const { signups } = await api("");
  const hits = signups.filter((s) => s.id === ref || s.id.startsWith(ref) || s.email === ref.toLowerCase());
  if (hits.length !== 1) throw new Error(`"${ref}" matches ${hits.length} signups`);
  return hits[0];
}

function gmailDraft(signup) {
  const subject = "You’re in: Stream Hijack alpha";
  const body = [
    "Hi,",
    "",
    `Thanks for joining the Stream Hijack waitlist with ${signup.channel}. You're in the next alpha batch.`,
    "",
    "Your invite to the private creator Discord (it works once and expires in 7 days):",
    signup.inviteUrl,
    "",
    "Say hi in #general and we'll get you set up in #setup-help: download, OBS, and your first hijack.",
    "",
    "Hyunseok",
    "Stream Hijack",
  ].join("\n");
  const q = new URLSearchParams({ view: "cm", fs: "1", authuser: SENDER, to: signup.email, su: subject, body });
  return `https://mail.google.com/mail/?${q}`;
}

async function invite(refs) {
  for (const ref of refs) {
    const s = await resolveId(ref);
    const done = await api(`/${s.id}/invite`, "POST");
    console.log(`✓ ${done.email}  ${done.inviteUrl}`);
    const url = gmailDraft(done);
    try {
      execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    } catch {
      console.log(`  open this draft: ${url}`);
    }
  }
}

async function decline(refs) {
  for (const ref of refs) {
    const s = await resolveId(ref);
    await api(`/${s.id}/decline`, "POST");
    console.log(`✗ declined ${s.email}`);
  }
}

async function main() {
  if (TOKEN.length < 32) {
    throw new Error("RH_ADMIN_TOKEN missing (≥32 chars) — set it in .env or the environment");
  }
  const [cmd = "list", ...rest] = process.argv.slice(2);
  if (cmd === "list") return list(rest[0]);
  if (!rest.length) throw new Error(`usage: npm run waitlist -- ${cmd} <id|email>…`);
  if (cmd === "invite") return invite(rest);
  if (cmd === "decline") return decline(rest);
  throw new Error(`unknown command "${cmd}" (list | invite | decline)`);
}

main().catch((e) => {
  console.error(`waitlist: ${e.message}`);
  process.exit(1);
});
