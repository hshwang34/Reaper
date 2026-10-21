# How we build — PM-led, agent-built

PM mode is opt-in: it runs only when the user says they want to product-manage (or `/pm`) —
the shared skill lives in `~/Documents/Projects/.claude/skills/pm/`; this file is the
project-specific part.

The product manager (the user) owns **what** and **why**. The eng lead (the main Claude Code
session) owns **how**, and runs specialist agents to do the work. The PM never has to read a
diff to make a decision.

```
PM ──── idea / priority ────▶ Eng lead ──── work orders ────▶ payments-engineer
   ◀─── brief + product Qs ───          ◀─── reports ───────── implementer
   ◀─── PR (product summary) ─                                 tester
   merges                                                      reviewer
```

## The loop (`/pm feature <idea>`)

1. **Brief.** The lead turns the idea into `briefs/NNN-slug.md` (template below): problem, who
   it's for, what success looks like, scope cuts, and open product questions — each with options
   and a recommendation. The PM approves or edits it. No code before approval.
2. **Plan + build.** The lead writes a specific work order and hands it to **one** writing agent
   in a feature worktree — `payments-engineer` for anything touching money, `implementer`
   otherwise. Other agents run alongside only to read, design tests, or review. (Multi-agent
   coding works when writes stay single-threaded; parallel writers mostly fail — see *Why it's
   shaped this way*.) A long session hands off to a fresh one via the brief.
3. **Gate.** Nothing reaches the PM until: `npm run check` passes (also enforced by a hook that
   blocks `git push` / `gh pr create` while it's red), `tester` has mapped every acceptance
   criterion, a fresh-context `reviewer` finds no blocking issue (money/safety checklists when
   relevant), and `npm run e2e` passes if the streamer/viewer pages changed. Max two fix rounds,
   then the lead escalates instead of looping.
4. **PR.** The lead opens a PR whose top section is written for the PM: what changed for
   streamers/viewers, how to see it, decisions made on the PM's behalf, risks. **The PM merges.**
   Deploys to `reality-hijack.fly.dev` and anything touching live Stripe happen only on the PM's
   explicit go.

**Fast lane:** a change the lead can describe in one sentence (copy, small fix, config) that
touches no money/safety code skips the brief and the agents — the lead does it, runs the gate,
and opens the PR, flagged as fast-lane. Multi-agent runs cost roughly 15× the tokens of a
plain session, so they're kept for work that earns it.

`/pm status` shows every brief, what's in flight, and what's waiting on the PM.

## Why it's shaped this way

Researched 2026-10-20; the choices trace to these sources:

- **One coordinator, single-threaded writes, other agents read/review** — Cognition,
  [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working) and
  [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents); Anthropic notes
  coding has fewer parallelizable parts than research
  ([multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **Specific work orders** (objective, output format, boundaries) — same Anthropic post.
- **Spec/brief first, PM interviewed via questions; fresh session to build; fresh-context
  reviewer that flags only real gaps; hooks for must-happen checks** — Claude Code
  [best practices](https://code.claude.com/docs/en/best-practices).
- **Agent definitions, tool allowlists, project-over-user precedence** — Claude Code
  [subagents docs](https://code.claude.com/docs/en/sub-agents).

Revisit after the first few features: Anthropic's advice is to start small and adjust from
what actually happens.

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
