# Work order · brief 002, PR 2 — pass B: studio, dashboard, previews, blocklist widening

Worktree: /Users/hyunseokhwang/Documents/Projects/RealityHijack/.claude/worktrees/feature-brand-ux-2 (branch feature-brand-ux-2). Node: `export PATH=~/.nvm/versions/node/v24.16.0/bin:$PATH`. **No push, no PR, no git config.** Commit on this branch (`git -c user.email=jacogoby@gmail.com commit`, message ends `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`). Pass A (wizard, friendlyError, server strings, tray) is already committed on this branch — build on it, don't redo it.

Read first: docs/product/BRAND.md (§3 vocabulary incl. the streamer rows, §4 buttons, §5 patterns, §8 blocklist), the brief, CLAUDE.md. Design audit: /private/tmp/claude-501/-Users-hyunseokhwang-Documents-Projects-RealityHijack/7f07afb5-2740-492d-b911-b4c634e790ba/scratchpad/work-orders-002/pr2-design-audit.md — §1 tables for RouterPage, studio/*, features/Safety*, dashboard/* are your line list; §2 UX findings; §3 previews.

## Goal
The studio and the hosted dashboard read as one product with the viewer page: same words, same button recipes, one primary per screen, money and safety panels with real loading/empty/error states, previews where streamers choose effects, and the jargon test covering every streamer surface.

## In scope
web/src/router/RouterPage.tsx · web/src/studio/{EffectsTab,EarningsTab,FirstRunTour,ui}.tsx · web/src/features/{SafetyEditor,SafetyPanels}.tsx · web/src/dashboard/{DashboardPage,PayoutsPanel,PayoutsDonePage}.tsx · web/test/copy.test.ts (scope + OBS allow-list) · scripts/e2e.mjs, scripts/studio-tour.mjs, scripts/e2e-hosted.mjs only where renamed strings break them. Out of scope: SetupPage, server, app/main, EffectArt internals (use its API as-is: `previewHandlers(id)`, `PreviewPlayButton`, `autoPlay`, `reducedMotionOnly` — check the exact exports).

## A · Vocabulary + copy (apply the audit tables)
Global swaps on these surfaces: viewer(s) → chat (when meaning "the audience") / a viewer (one person); portal → hijack page; creator → streamer ("Creator studio" header only); tip/tipped → paid/payment; typed idea → custom effect; router → studio; queue/queued → in line; ledger / Hijack ledger → Recent hijacks; output guard/watcher → live safety check (e2e.mjs:165 `/output (guard|watcher) ready/i` → update to `/live safety check ready/i`); Reinstall overlay / Re-provision → Add the overlay again (studio-tour.mjs:306 `/reinstall overlay/i` → `/add the overlay again/i`); Safety tab → **Rules** (studio-tour.mjs:314 `/^safety$/i` → `/^rules$/i`; h1 "Viewer rules" → "Rules"); completed/failed/dispatched → Played / Didn't play / Refunded / In progress (EarningsTab + dashboard list; "Refunded" when the payment row says refunded). Panic key text everywhere from `PANIC_KEY` (never hard-coded ⌘⇧H); tooltip/tour mention Esc only where the studio is focused.
Keep these anchors (scripts match them): `/turn on stream hijack/i`, `/OBS\s*connected/i`, `/Ready · waiting for a viewer/`, `/try an effect on me/i`, `/Effect live/`, `/stop effect/i`, `/Paused/`, `/resume hijacks/i`, `/Installed in/` and the curly-quoted `overlay in “Just Chatting” over “Facecam”` line, `/^how it works$/i`, `/How it works · 1 of 4/i`, `/^next$/i`, `/explore the effects/i`, `/What your viewers can do/` → you may rename to "What chat can do" **if** you update studio-tour.mjs:261 in the same commit; `/Haunted available/i` switch labels, tabs `/^off$/i` `/^all$/i` `/^live$/i` `/^earnings$/i`, radios "Family-friendly" / "Balanced" / "Anything goes", `/^I approve each$/i`, `getByLabel(/extra blocked words/i)`, `/Cyberpunk City/`, `/^skip$/i`. The tour's jargon regex (studio-tour.mjs:268) must keep passing on the Effects tab.

## B · UX
1. **Live tab**: one primary. While the camera is off, "Turn on Stream Hijack" is the only filled button; "Copy link" becomes secondary. Add the **payouts-not-ready banner** at the top of Live when hosted and `charges_enabled` is false: "Chat can't pay yet. Set up payouts to start earning." with a secondary "Set up payouts" that jumps to Earnings. Studio `settings` load failure → an error card with Try again instead of "Loading your rules…" forever.
2. **Effects tab**: skeleton while settings load; previews on every card (hover/focus plays; `PreviewPlayButton` as a sibling inside the existing relative art wrapper; one at a time; dimmed-but-playable when the effect is off); "Try on me" stays ghost.
3. **FirstRunTour**: `autoPlay` preview on the visible slide only, stop on slide change, reduced-motion → still + play button; keep the "Lava Room · 15 seconds" before→after caption.
4. **Rules (SafetyEditor)**: switching level overwrites custom rules — show a 6 s undo toast ("Switched to Balanced. Undo") rather than a modal; Unban × and Ban get the same undo pattern; Approve/Decline on a review: Decline refunds a paying viewer → confirm inline ("Decline and refund $X?" → Decline / Keep) — ⚠ money, meaning unchanged. Footnotes and policy lines at 14px.
5. **Earnings**: fetch failure shows an error card ("We couldn't load your earnings. Try again."), never the empty state; empty state per BRAND §5 ("No hijacks yet. Share your hijack page and chat can start paying."); column "Tip" → "Paid".
6. **Dashboard** (hosted): skeleton for settings + list; errors inline per panel via friendlyStreamerError; PayoutsPanel shows "Loading payouts…" instead of a blank card; ModerationPanel/ReviewPanel surface fetch failures; h1 "creator dashboard" → "Studio".
7. **Sign out**: add a ghost "Sign out" (danger on confirm: "Sign out of Stream Hijack? Chat won't be able to pay until you sign in again." → Sign out / Stay) in the studio header menu and the dashboard — only if an existing sign-out path exists in auth.ts/desktop bridge; if there is none, report it as a follow-up and don't invent one.
8. Touch/text: `btn.*` → min-h-11; Approve/Decline/Ban/Unban/Skip ≥44px; the two `text-[11px]` → 12px; money/policy lines 14px.
9. RouterPage current-job card: still only (never plays); custom effects use the "Custom effect" tile.

## C · Blocklist test
web/test/copy.test.ts: scan all of `web/src/**` (not tests), exempting string literals that are quoted OBS menu names per BRAND §3 (match `"Browser"`, `"WebSocket Server Settings"`, `"Virtual Camera"`, `"Sources"`, `"Program"`, `"Preview"` inside straight or curly quotes only) and the local-demo-rig claim-code view. Everything must pass; fix copy rather than widening exemptions.

## D · Gate
`npm run check`, `npm run e2e`, `npm run e2e:wizard`, `npm run e2e:hosted`, `npm run tour` — all green; attach the tour's screenshot dir path.

## Report (≤40 lines)
1. What changed for streamers. 2. Engineering decisions. 3. Product questions (safe default taken). 4. Out of scope seen. 5. Test counts per command. 6. Commit sha(s).

## E · Carry-overs from pass A (small, do them)
- friendlyError: the server's upload 413 (server limit is 5 MB, `server/src/index.ts:249`, `sidecar/src/uploads.ts:34`) → "That photo is over 5 MB. Pick a smaller one." — distinct from the client-side 25 MB message. Reword `apiRouter.ts` "image too large" at the source too.
- ReviewPanel (features/SafetyPanels.tsx): `reviewWhy` and ledger `reason` text shown to streamers must go through `friendlyStreamerError`/a reason→label map (Played / Didn't play / Refunded / Stopped by your rules / Declined by you); the CSAM-quarantine reason text (`core/src/submissions.ts` ~435/447) must NEVER render in any streamer list — assert that in a test.
- Blocklist allow-list must also cover the quoted OBS menu path "Tools → WebSocket Server Settings → Enable" used by the wizard's manual instruction (pass A).
- Pass A's gate counts to beat or match: check (core 88, web 38, server 33, sidecar 11, app 7), e2e 29, e2e:wizard 11, e2e:hosted 42, tour 36.
