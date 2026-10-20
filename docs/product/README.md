# How we build — PM-led, agent-built

The product manager (Hyunseok) owns **what** and **why**. The eng lead (the main Claude Code
session) owns **how**, and runs specialist agents to do the work. The PM never has to read a
diff to make a decision.

```
PM ──── idea / priority ────▶ Eng lead ──── work orders ────▶ payments-engineer
   ◀─── brief + product Qs ───          ◀─── reports ───────── implementer
   ◀─── PR (product summary) ─                                 tester
   merges                                                      reviewer
```

## The loop (`/feature <idea>`)

1. **Brief.** The lead turns the idea into `briefs/NNN-slug.md` (template below): problem, who
   it's for, what success looks like, scope cuts, and open product questions — each with options
   and a recommendation. The PM approves or edits it. No code before approval.
2. **Plan + build.** The lead splits the brief into work orders and runs agents in isolated
   worktrees, in parallel where files don't overlap. Payments work always goes to
   `payments-engineer`.
3. **Gate.** Nothing reaches the PM until: `npm run check` passes, `tester` has mapped every
   acceptance criterion, `reviewer` says ship (money/safety checklists when relevant), and
   `npm run e2e` passes if the streamer/viewer pages changed. Max two fix rounds, then the lead
   escalates instead of looping.
4. **PR.** The lead opens a PR whose top section is written for the PM: what changed for
   streamers/viewers, how to see it, decisions made on the PM's behalf, risks. **The PM merges.**
   Deploys to `reality-hijack.fly.dev` and anything touching live Stripe happen only on the PM's
   explicit go.

`/status` shows every brief, what's in flight, and what's waiting on the PM.

## What comes to the PM vs. what doesn't

| Comes to the PM (product calls) | Decided by the lead (logged in the brief) |
|---|---|
| Prices, fees, minimums, payout timing — anything a user sees about money | Code structure, libraries, data models |
| Who can do what (viewer / streamer / us), defaults of streamer settings | Test strategy, refactors needed to do the work |
| Content-safety policy and thresholds | Error handling, retries, performance work |
| UX flow and copy tone where it changes the experience | Internal naming, file layout |
| Scope cuts and sequencing between features | Which agent does what |
| Anything that spends real money, deploys, or is hard to reverse | Fixing bugs found along the way inside scope |

Questions are batched (≤4 at a time), each with options and a recommendation. Every answer is
appended to `DECISIONS.md` so it's never asked twice; agents read that file before raising a
question.

## Files

- `DECISIONS.md` — the product decision log. Append-only; superseded entries are marked, not deleted.
- `briefs/` — one file per feature; `TEMPLATE.md` is the shape. Status line at the top:
  `draft → approved → building → in review (PR #n) → shipped | dropped`.
