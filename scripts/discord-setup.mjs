#!/usr/bin/env node
// One-shot (and re-runnable) build of the Stream Hijack creator Discord:
//
//   npm run discord:setup -- <guild id>               # token from ~/.discord-setup-token
//   DISCORD_BOT_TOKEN=… npm run discord:setup -- <guild id>
//   npm run discord:setup -- <guild id> --revoke-open-invites
//
// The server is invite-only by design: the waitlist (server/src/waitlist.ts)
// hands each approved streamer a single-use invite, so applicants never see
// the member count an open invite page shows. That only holds if nobody else
// can mint invites, so this script also strips "Create Invite" from @everyone
// and reports (or, with the flag, revokes) any open invite already out there.
//
// Idempotent: everything is found by name first and only created if missing;
// welcome/rules are posted only if the bot hasn't posted them already. What it
// can't do (owner-only): require 2FA for moderators — Server Settings → Safety
// Setup. It never deletes a channel that has anything in it.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const API = "https://discord.com/api/v10";
const args = process.argv.slice(2);
const GUILD = args.find((a) => /^\d{17,20}$/.test(a)) ?? process.env.DISCORD_GUILD_ID;
const REVOKE_OPEN = args.includes("--revoke-open-invites");
const tokenFile = resolve(homedir(), ".discord-setup-token");
const TOKEN =
  process.env.DISCORD_BOT_TOKEN?.trim() || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");

// Permission bits (discord.com/developers/docs/topics/permissions).
const P = {
  CREATE_INVITE: 1n << 0n,
  KICK: 1n << 1n,
  BAN: 1n << 2n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  VIEW: 1n << 10n,
  SEND: 1n << 11n,
  SEND_IN_THREADS: 1n << 38n,
  CREATE_THREADS: (1n << 35n) | (1n << 36n),
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_NICKNAMES: 1n << 27n,
  MODERATE_MEMBERS: 1n << 40n,
};
const TEXT = 0;
const CATEGORY = 4;
const ANNOUNCEMENT = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discord(method, path, body) {
  for (;;) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Audit-Log-Reason": "discord-setup.mjs",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const { retry_after = 1 } = await res.json().catch(() => ({}));
      await sleep(retry_after * 1000 + 100);
      continue;
    }
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  }
}

const say = (s) => console.log(s);

// ── Copy ──────────────────────────────────────────────────────────────────

const WELCOME = `## Welcome to Stream Hijack 👋
You're here because you made it off the waitlist. This is the private creator alpha: a small group of streamers putting real hijacks on real streams.

**Start here**
1. Read <#RULES>.
2. Say hi in <#GENERAL>: your channel, what you stream, and the first thing you'd let chat turn you into.
3. Ready to install? Post in <#SETUP> and we'll walk you through the app, OBS and your first test hijack.

**Where things go**
• <#SHOW> clips and screenshots of hijacks that landed
• <#IDEAS> effect and preset ideas
• <#BUGS> anything broken (what you did, what you expected, what happened)
• <#FEEDBACK> everything else. It shapes what we build next.

Invites here are single-use and come only from the waitlist, so please don't share links. Send friends to **streamhijack.com** instead.`;

const RULES = `## 📜 Server rules
**1. Be decent.** No harassment, hate, slurs, or targeting anyone: streamers, viewers or staff.
**2. Keep it SFW.** No sexual content, gore or shock content, in chat, images or hijack prompts.
**3. Zero tolerance for content sexualizing minors.** Instant permanent ban and a report to the authorities.
**4. Consent.** Don't post other people's faces or streams without their OK.
**5. No spam or DM advertising.** Your own stream is welcome in <#SHOW>.
**6. Use the right channel.** Bugs in <#BUGS>, install help in <#SETUP>. It gets things fixed faster.
**7. Alpha is confidential.** Don't share builds, invite links or unannounced features until we announce them.
**8. Mods have the final say.** Disagree? DM a mod instead of arguing in public.

Breaking these means removal from the server and the alpha.`;

// ── Layout ────────────────────────────────────────────────────────────────
// key → used to fill <#KEY> mentions in the copy above.

const LAYOUT = [
  {
    category: "INFO",
    readOnly: true,
    channels: [
      { key: "WELCOME", name: "welcome", topic: "Start here." },
      { key: "RULES", name: "rules", topic: "Read before posting." },
      // Created as an Announcement channel once Community is on (below).
      { key: "NEWS", name: "announcements", topic: "Releases and alpha news.", announcement: true },
    ],
  },
  {
    category: "COMMUNITY",
    channels: [
      { key: "GENERAL", name: "general", topic: "Say hi: your channel, what you stream." },
      { key: "SHOW", name: "show-your-hijacks", topic: "Clips and screenshots of hijacks that landed." },
      { key: "IDEAS", name: "prompt-ideas", topic: "Effect and preset ideas." },
    ],
  },
  {
    category: "ALPHA",
    channels: [
      { key: "SETUP", name: "setup-help", topic: "Install, OBS and first-hijack help." },
      { key: "BUGS", name: "bug-reports", topic: "What you did, what you expected, what happened." },
      { key: "FEEDBACK", name: "feedback", topic: "What should we build next?" },
    ],
  },
  {
    category: "STAFF",
    staffOnly: true,
    channels: [
      { key: "MODLOG", name: "mod-log", topic: "AutoMod alerts." },
      { key: "DISCORD_UPDATES", name: "discord-updates", topic: "Discord's own notices to admins." },
    ],
  },
];

async function main() {
  if (!TOKEN) throw new Error(`no bot token — put it in ${tokenFile} (chmod 600) or DISCORD_BOT_TOKEN`);
  if (!GUILD) throw new Error("usage: npm run discord:setup -- <guild id>");

  const guild = await discord("GET", `/guilds/${GUILD}`);
  const me = await discord("GET", "/users/@me");
  say(`server: ${guild.name} (${guild.id}) as bot ${me.username}`);

  // ── Roles ──
  let roles = await discord("GET", `/guilds/${GUILD}/roles`);
  const everyone = roles.find((r) => r.id === GUILD);
  let mod = roles.find((r) => r.name === "Mod");
  const modPerms =
    P.KICK | P.BAN | P.VIEW_AUDIT_LOG | P.MANAGE_MESSAGES | P.MANAGE_NICKNAMES | P.MODERATE_MEMBERS | P.VIEW | P.SEND;
  if (!mod) {
    mod = await discord("POST", `/guilds/${GUILD}/roles`, {
      name: "Mod",
      permissions: String(modPerms),
      color: 0xff4b2b,
      hoist: true,
      mentionable: true,
    });
    say("+ role Mod");
  }
  // Members can't mint their own invites — only the waitlist hands them out.
  const evPerms = BigInt(everyone.permissions);
  if (evPerms & P.CREATE_INVITE) {
    await discord("PATCH", `/guilds/${GUILD}/roles/${GUILD}`, { permissions: String(evPerms & ~P.CREATE_INVITE) });
    say("~ @everyone can no longer create invites");
  }

  // ── Channels ──
  let channels = await discord("GET", `/guilds/${GUILD}/channels`);
  const find = (name, type) => channels.find((c) => c.name === name && (type === undefined || c.type === type));
  const ids = {};
  const deferred = [];

  const overwritesFor = (group) => {
    if (group.staffOnly) {
      return [
        { id: GUILD, type: 0, allow: "0", deny: String(P.VIEW) },
        { id: mod.id, type: 0, allow: String(P.VIEW | P.SEND), deny: "0" },
      ];
    }
    if (group.readOnly) {
      return [
        { id: GUILD, type: 0, allow: String(P.VIEW), deny: String(P.SEND | P.CREATE_THREADS | P.SEND_IN_THREADS) },
        { id: mod.id, type: 0, allow: String(P.SEND), deny: "0" },
      ];
    }
    return [];
  };

  let position = 0;
  for (const group of LAYOUT) {
    const permission_overwrites = overwritesFor(group);
    let cat = find(group.category, CATEGORY);
    if (!cat) {
      cat = await discord("POST", `/guilds/${GUILD}/channels`, { name: group.category, type: CATEGORY, permission_overwrites });
      channels.push(cat);
      say(`+ category ${group.category}`);
    } else {
      await discord("PATCH", `/channels/${cat.id}`, { permission_overwrites });
    }
    await discord("PATCH", `/channels/${cat.id}`, { position: position++ });

    for (const [i, ch] of group.channels.entries()) {
      if (ch.announcement) {
        deferred.push({ ch, cat, permission_overwrites, i });
        continue;
      }
      const spec = { parent_id: cat.id, topic: ch.topic, position: i, permission_overwrites };
      let c = find(ch.name, TEXT) ?? find(ch.name, ANNOUNCEMENT);
      if (!c) {
        c = await discord("POST", `/guilds/${GUILD}/channels`, { name: ch.name, type: TEXT, ...spec });
        channels.push(c);
        say(`+ #${ch.name}`);
      } else {
        await discord("PATCH", `/channels/${c.id}`, spec);
      }
      ids[ch.key] = c.id;
    }
  }

  // ── Community ── (verified-email gate, media scan on everyone, rules screen)
  if (!guild.features.includes("COMMUNITY")) {
    await discord("PATCH", `/guilds/${GUILD}`, {
      features: [...guild.features, "COMMUNITY"],
      verification_level: 2, // email verified + registered for 5+ minutes
      explicit_content_filter: 2, // scan media from all members
      default_message_notifications: 1, // only @mentions
      rules_channel_id: ids.RULES,
      public_updates_channel_id: ids.DISCORD_UPDATES,
    });
    say("~ Community enabled");
  } else {
    await discord("PATCH", `/guilds/${GUILD}`, {
      rules_channel_id: ids.RULES,
      public_updates_channel_id: ids.DISCORD_UPDATES,
    });
  }

  // Announcement channels exist only on Community servers.
  for (const { ch, cat, permission_overwrites, i } of deferred) {
    const spec = { parent_id: cat.id, topic: ch.topic, position: i, permission_overwrites };
    let c = find(ch.name, ANNOUNCEMENT) ?? find(ch.name, TEXT);
    if (!c) {
      c = await discord("POST", `/guilds/${GUILD}/channels`, { name: ch.name, type: ANNOUNCEMENT, ...spec });
      say(`+ #${ch.name} (announcement)`);
    } else {
      await discord("PATCH", `/channels/${c.id}`, c.type === TEXT ? { ...spec, type: ANNOUNCEMENT } : spec);
    }
    ids[ch.key] = c.id;
  }

  // Template leftovers ("Text Channels" / "Voice Channels"): removed only when empty.
  channels = await discord("GET", `/guilds/${GUILD}/channels`);
  for (const name of ["Text Channels", "Voice Channels"]) {
    const cat = channels.find((c) => c.type === CATEGORY && c.name === name);
    if (cat && !channels.some((c) => c.parent_id === cat.id)) {
      await discord("DELETE", `/channels/${cat.id}`);
      say(`- empty category "${name}"`);
    } else if (cat) {
      say(`  left "${name}" in place (it still has channels — move or delete them by hand)`);
    }
  }

  // ── Copy ── posted once (skipped if the bot already posted in that channel)
  const fill = (s) => s.replace(/<#([A-Z_]+)>/g, (_, k) => (ids[k] ? `<#${ids[k]}>` : `#${k.toLowerCase()}`));
  for (const [key, text] of [
    ["WELCOME", WELCOME],
    ["RULES", RULES],
  ]) {
    const recent = await discord("GET", `/channels/${ids[key]}/messages?limit=20`);
    if (recent.some((m) => m.author.id === me.id)) continue;
    const msg = await discord("POST", `/channels/${ids[key]}/messages`, {
      content: fill(text),
      allowed_mentions: { parse: [] },
    });
    await discord("PUT", `/channels/${ids[key]}/pins/${msg.id}`).catch(() => {});
    say(`+ posted ${key.toLowerCase()}`);
  }

  // ── AutoMod ── block + alert in #mod-log
  const actions = [
    { type: 1, metadata: { custom_message: "Blocked by Stream Hijack AutoMod." } },
    { type: 2, metadata: { channel_id: ids.MODLOG } },
  ];
  const rules = await discord("GET", `/guilds/${GUILD}/auto-moderation/rules`);
  for (const rule of [
    { name: "Flagged words", trigger_type: 4, trigger_metadata: { presets: [1, 2, 3] } },
    { name: "Spam", trigger_type: 3 },
    { name: "Mention spam", trigger_type: 5, trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true } },
  ]) {
    if (rules.some((r) => r.trigger_type === rule.trigger_type)) continue;
    try {
      await discord("POST", `/guilds/${GUILD}/auto-moderation/rules`, {
        ...rule,
        event_type: 1,
        actions,
        enabled: true,
        exempt_roles: [mod.id],
      });
      say(`+ AutoMod: ${rule.name}`);
    } catch (e) {
      say(`! AutoMod "${rule.name}" not created: ${e.message}`);
    }
  }

  // ── Open invites ── anything reusable defeats the waitlist
  const invites = await discord("GET", `/guilds/${GUILD}/invites`);
  const open = invites.filter((i) => i.max_uses !== 1);
  for (const inv of open) {
    const desc = `discord.gg/${inv.code} by ${inv.inviter?.username ?? "?"} (${inv.max_uses || "∞"} uses, ${inv.max_age ? `${inv.max_age / 3600}h` : "never expires"})`;
    if (REVOKE_OPEN) {
      await discord("DELETE", `/invites/${inv.code}`);
      say(`- revoked open invite ${desc}`);
    } else {
      say(`! open invite still live: ${desc} — rerun with --revoke-open-invites`);
    }
  }

  say("\nDone. Still yours to do (owner-only, ~1 min):");
  say("  · Server Settings → Safety Setup → require 2FA for moderator actions");
  say("  · Server Settings → Access → keep it on Invite Only (not Discoverable / Apply to Join)");
  say("\nFor the control plane's waitlist invites:");
  say(`  DISCORD_INVITE_CHANNEL_ID=${ids.WELCOME}`);
}

main().catch((e) => {
  console.error(`discord-setup: ${e.message}`);
  process.exit(1);
});
