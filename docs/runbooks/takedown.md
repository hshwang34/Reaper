# Runbook: removal requests (TAKE IT DOWN Act) and viewer reports

**Trigger:** a `[safety] TAKEDOWN request <id> …` warning, or a ledger row with
`stage: "takedown"`. Requests arrive through the portal footer link ("Request
removal of an image of you") or `POST /api/takedown` (`/api/c/<channel>/takedown`
on the hosted plane).

The FTC has enforced the TAKE IT DOWN Act's platform duty since 2026-05-19: a valid
request means removing the image and "known identical copies" within **48 hours**.
Whether a claim-code portal counts as a "covered platform" is unsettled
(CONTENT-SAFETY §9), so the system is built as if it does. This is not legal advice.

## What the code does on receipt

- **When the request names an image URL** (the upload's random filename): the
  upload and every stored **exact** copy (same sha256) are deleted at once, and
  that exact picture is blocked from being uploaded again
  (`core/src/uploadRegistry.ts`). Near-duplicates are **not** touched
  automatically, because an anonymous request proves nothing about other people's
  look-alike photos. Re-compressed or resized copies are the streamer's call (step 3).
- **The requester's contact** goes to an operator-only store (`takedown_contacts`
  hosted, `moderation.contacts.jsonl` locally). It is never written to the ledger
  the streamer reads.
- **When the request names only a claim code or description:** the request is
  recorded and nothing is deleted. A 4-character code can be guessed, so acting on
  it anonymously would let anyone delete strangers' uploads. A person follows up
  below.
- **Either way:** a ledger row with a ticket id, the requester's contact and the
  count of removed files. The 48-hour clock starts at that row's `ts`.
- Requests are rate-limited at 10 per minute per IP hash.

Uploads only live for the length of their job anyway. They're deleted when the
submission expires (10 minutes untipped), when the job ends, or after one hour at
most. Most requests will find the image already gone. Answer them anyway.

## What a person must do (within 48 hours of the ledger `ts`)

1. Read the request in the moderation log (router page → Safety, or the hosted
   dashboard).
2. If files were removed automatically, confirm to the requester. Their contact is
   in the operator-only store, keyed by the ticket id.
3. If not (code or description only), or if the request is credible and
   re-compressed copies may exist, find the upload in the ledger: match the claim
   code or time to an `image` row's `inputHash`. Then act on it:
   - call the streamer-authenticated `POST /moderation/takedown` with
     `{ sha256 }` (or `{ imageUrl }`). This removes and blocks exact **and**
     near-duplicate copies;
   - **ban the submitter** in the channel's settings (`bannedViewers`; the ledger's
     ban button does this) if the request is credible.
4. If a stream VOD or clip shows the image, the copy is on the streaming platform,
   not on us. Point the requester to the platform's own removal process (YouTube
   privacy complaints, Twitch reporting) and tell the streamer.
5. Note the outcome in the incident log, with the ticket id and the time actioned.

## Viewer reports (`stage: "report"`)

These are not legal requests. They tell the streamer that an effect or overlay felt
wrong. Review them in the moderation log. Repeated reports about one tipper are
grounds for a ban. A report describing nudity or a minor goes to the CSAM runbook
(`docs/runbooks/csam.md`) if any upload was involved.
