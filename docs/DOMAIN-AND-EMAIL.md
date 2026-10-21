# Domain + email: streamhijack.com

The product was renamed **Reality Hijack → Stream Hijack** (2026-10). This is the
manual checklist for the parts code can't do: buying the domain, the Google
Workspace mailbox, and pointing the live services at it. Every account here is a
**personal** one (`hshwang34` / jacogoby@gmail.com) — never an `@augmend.health` login.

## Why this shape

- **`.com`, not a $5 TLD.** `.stream`, `.win`, `.xyz`, `.top` are cheap because
  spammers use them, and Gmail/Outlook score mail from them accordingly. Streamer
  outreach is cold email, so deliverability decides the TLD.
- **Google Workspace, not forwarding.** One paid seat gives a real Gmail inbox,
  DKIM signing on our own domain, and free aliases — the best inbox placement for
  outreach at the lowest effort.
- **Infra slugs stay.** The Fly app (`reality-hijack`) and the Vercel project
  (`reality-hijack`) keep their names; the domain is pointed *at* them. Renaming a
  Fly app means a new app + volume migration for zero user-visible gain.

## 1. The domain — done (2026-10-20)

**streamhijack.com** is registered at Porkbun (account `hshwang34`, ~$11/yr,
WHOIS privacy on, auto-renew on). DNS stays at Porkbun. API access is enabled for
the domain; the key lives in the project `.env` as `PORKBUN_API_KEY` /
`PORKBUN_SECRET_KEY` (gitignored) so DNS changes can be scripted. Porkbun's
default parking records (apex `ALIAS` + `*` `CNAME` → `uixie.porkbun.com`) were
deleted — they shadow every record below.

## 2. Google Workspace (Business Starter, one seat)

1. workspace.google.com → sign up with a personal Google account → "use a domain
   I already own" → `streamhijack.com`.
2. Verify ownership with the TXT record Google shows.
3. Create the one user: **`jacob@streamhijack.com`** (the outreach identity — a
   person's name beats a role address for cold email replies).
4. Add free aliases to that user (Admin → Users → *Alternate emails*):
   - `hello@` — public Contact Us (site footer)
   - `creators@` — streamer partnerships (site footer)
   - `support@` — app/install help
   - `dmarc@` — receives DMARC reports
5. In Gmail → Settings → Accounts → *Send mail as*, add `hello@` and `creators@`
   so replies go out from the address they came in on.

## 3. DNS records

| Purpose | Type | Name | Value |
|---|---|---|---|
| Workspace mail | MX | `@` | `smtp.google.com` (priority 1) |
| SPF | TXT | `@` | `v=spf1 include:_spf.google.com ~all` |
| DKIM | TXT | `google._domainkey` | generated in Admin → Gmail → *Authenticate email* (2048-bit), then click **Start authentication** |
| DMARC | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@streamhijack.com` — tighten to `p=quarantine` after ~2 clean weeks |
| Marketing site ✅ | A | `@` | `216.198.79.1` and `64.29.17.1` (Vercel's current recommendation) |
| Marketing site ✅ | CNAME | `www` | `61c8695760e14eef.vercel-dns-017.com` (project-specific, from `vercel domains verify`) |
| Control plane ✅ | A / AAAA | `app` | `66.241.124.68` / `2a09:8280:1::1c0:fd56:0` (from `fly certs add`; cert issued) |

✅ = live since 2026-10-20. The mail rows wait on the Workspace signup; until
then Porkbun's own forwarding MX/SPF records are still in place — replace them,
don't add alongside.

Check with Google's [Check MX](https://toolbox.googleapps.com/apps/checkmx/) and by
sending a test to a Gmail address → *Show original* → SPF/DKIM/DMARC all `PASS`.

## 4. Point the services at it

1. **Site:** `vercel domains add streamhijack.com` (and `www`) on project
   `reality-hijack`; set `www` → apex redirect in the Vercel dashboard.
2. **Control plane:** `fly certs add app.streamhijack.com --app reality-hijack`.
3. Then every place that bakes the public URL moves to `https://app.streamhijack.com`:
   - `fly secrets set RH_PUBLIC_URL=https://app.streamhijack.com --app reality-hijack`
   - Twitch dev console → OAuth redirect `https://app.streamhijack.com/auth/twitch/callback`
     (keep the fly.dev one until old installs are gone)
   - Stripe → webhook endpoint + Connect redirect URLs
   - GitHub repo variable `RH_CLOUD_URL` (baked into app builds — **do this before
     the first public release**, or shipped installers point at fly.dev forever)
   - default `RH_SMOKE_URL` in `scripts/smoke-*.mjs`

## 5. Sending etiquette (deliverability)

- Warm up: 5–10 hand-written emails/day for the first two weeks, then grow slowly.
- Find addresses in a streamer's Twitch *About* panel ("business inquiries").
- One-to-one, plain text, a real ask, an easy opt-out line. No bulk tools on this
  domain — if volume outreach ever happens, use a separate sending domain so a
  spam complaint can't sink `hello@`.

## Rename notes

- The desktop app's display name changed, so its data folder moved too:
  `~/Library/Application Support/Stream Hijack/` (`%APPDATA%\Stream Hijack\`). An
  install of the old build keeps its settings under the old folder; there are no
  public releases yet, so there is no migration — re-run the setup wizard.
- The macOS/Windows bundle id is now `com.streamhijack.app`. It must not change
  again after the first signed release (auto-update and notarization key off it).
