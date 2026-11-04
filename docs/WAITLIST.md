# Streamer waitlist → creator Discord

The alpha is invite-only. Streamers apply on streamhijack.com. You approve them in
batches, and each approved streamer gets a **single-use Discord invite** by email.

```
site form ──POST /api/waitlist──▶ control plane (SQLite `waitlist`)
                                      │
             npm run waitlist ────────┤  GET  /api/admin/waitlist
             (you, with RH_ADMIN_TOKEN)  POST /api/admin/waitlist/:id/invite
                                      │        └─▶ Discord bot: 1-use, 7-day invite to #welcome
                                      ▼
              Gmail draft from hello@ opens with the link → you press send
```

## Why this shape

- **The gate is on our site, not in Discord.** Every Discord invite page shows
  "N online · M members", and no server setting hides it. Discord's own "Apply to Join"
  opens from that same page. With the waitlist, applicants never see a Discord link
  until they're approved.
- **Single-use, expiring invites.** A forwarded link lets in at most one person and
  dies after 7 days. The setup script also takes "Create Invite" away from members,
  so nobody can mint an open link from inside the server.
- **You send the email by hand.** streamhijack.com is a new sending domain
  (DOMAIN-AND-EMAIL.md §5). The CLI opens a pre-filled Gmail draft as `hello@`
  instead of sending through an API, so each approval is one real, hand-sent email.
- **One email, one row.** A second signup with the same email is silently ignored,
  so the form can't be used to check whether someone has already applied. The only
  personal data we store is the email and channel the applicant typed, plus a salted
  IP hash for abuse checks.

## One-time setup

1. **Create the Discord server** (personal account) and upload
   `branding/hijacker-v2/mascot-expressive.png` as the icon.
2. **Create a bot.** discord.com/developers/applications → New Application →
   **Bot** → Reset Token. Then **OAuth2 → URL Generator** → scope `bot`, permission
   `Administrator` → open the URL and add the bot to the server.
3. **Save the token** outside the repo:
   `read -s "T?Token: " && echo "$T" > ~/.discord-setup-token && chmod 600 ~/.discord-setup-token`
4. **Build the server:** `npm run discord:setup -- <server id>`. To get the ID, turn
   on Developer Mode, then right-click the server → Copy Server ID. The script
   creates roles, channels, Community mode, the welcome and rules posts, and AutoMod.
   Re-running it is safe. It prints `DISCORD_INVITE_CHANNEL_ID=…`. Add
   `--revoke-open-invites` to kill any reusable invite already out there.
5. **Owner-only steps in Discord:**
   - Safety Setup → require 2FA for moderator actions.
   - Access → **Invite Only**.
6. **Control plane secrets.** Setting secrets restarts the production machine.
   ```bash
   fly secrets set --app reality-hijack \
     RH_ADMIN_TOKEN=$(openssl rand -hex 32) \
     DISCORD_BOT_TOKEN=$(cat ~/.discord-setup-token) \
     DISCORD_INVITE_CHANNEL_ID=<from step 4>
   ```
   Put the same `RH_ADMIN_TOKEN` in your local `.env` for the CLI.
7. **Deploy:** `fly deploy --remote-only` from the repo root (server), and merge
   to `main` for the site (Vercel).

Until steps 6–7 are done, the live form still collects signups once the server
is deployed. Approving a signup just answers 503 until Discord is configured.

## Day to day

```bash
npm run waitlist                         # pending, oldest first
npm run waitlist -- list all             # pending | invited | declined | all
npm run waitlist -- invite 1a2b3c4d …    # id prefix or email; opens one Gmail draft each
npm run waitlist -- decline 1a2b3c4d
```

Inviting someone who was already invited returns their stored link and never mints
a second one. Approved streamers land in #welcome. Give the trusted ones the
**Mod** role as the server grows.
