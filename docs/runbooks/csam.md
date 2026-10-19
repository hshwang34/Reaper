# Runbook: suspected CSAM upload

**Trigger:** a `[safety] SUSPECTED CSAM upload quarantined (sha256 …)` warning in the
logs, or a ledger row with `categories: ["csam-suspected"]`. This fires when an image
classifier reports sexual content **and** a possibly-minor face on the same upload
(`core/src/moderation.ts` → `moderateImage`).

This is not legal advice. It is the engineering procedure the code was built around
(docs/CONTENT-SAFETY.md §1, S5). Get counsel involved as soon as there is a real hit.

## What the code has already done

1. **Stopped the chain.** No further vendor saw the bytes. The minors-covering
   classifier runs first, and a positive returns before the next one is called.
   The bytes never reach the Claude policy classifier or Decart.
2. **Quarantined, did not delete.** The file was moved out of the served uploads
   tree, owner-only:
   - local rig: `sidecar/safety/quarantine/`
   - Electron app: `<userData>/safety/quarantine/`
   - hosted plane: `RH_QUARANTINE_DIR` (default `server/safety/quarantine/`; on
     Fly, a volume)
3. **Blocked the picture.** Its sha256 and dHash are on the runtime's block list, so
   identical or near-identical re-uploads are refused. The list is in memory per
   runtime; see step 4.
4. **Struck the submitter.** Three strikes block their IP hash for an hour.
5. **Wrote the ledger row** with the hash, the salted IP hash, the tipper name if
   given, and the timestamp. The ledger never holds the bytes.

## What a person must do

| When | Step |
|---|---|
| Immediately | Do **not** open, copy, forward or re-upload the file to any service, including a classifier, a chat tool or an email. Viewing it is not needed to report it. |
| Same day | Report to the **NCMEC CyberTipline** (report.cybertip.org). 18 U.S.C. §2258A requires a provider with actual knowledge to report "as soon as reasonably possible". Include the ledger row (time, sha256, salted IP hash, channel) and what the classifier reported. Register as an Electronic Service Provider beforehand. That registration is a Phase C prerequisite, so it shouldn't be the first time. |
| Same day | Notify Decart: `dsa@decart.ai`. Their AUP asks redistributors to report CSAM attempts. |
| Same day (hosted) | Suspend the channel if the streamer appears involved (`channels.suspended = 1`, which takes effect on the next lookup). |
| 1 year | **Preserve** the quarantined file and its ledger row for one year (REPORT Act, 2024). Restrict access to the people handling the report. |
| After a restart | Re-add the hash to the block list. The list doesn't survive a restart yet; persisting it is an open item. |
| After 1 year | Delete the quarantined file unless law enforcement has asked you to keep it longer. |

## False positives

Classifiers will sometimes flag an innocent image, such as an adult with a youthful
face or a swimsuit photo. Treat every hit as real until a person with the right role
has decided otherwise. That person decides from the classifier output and metadata,
not by circulating the image. Record the decision in the incident notes.

## Open items (CONTENT-SAFETY §8 Phase C)

- Hash-match **known** CSAM before classification. Options: Cloudflare's free CSAM
  Scanning Tool (needs uploads served through Cloudflare) or PhotoDNA (vetted access).
- NCMEC ESP registration.
- Persist the block list across restarts.
