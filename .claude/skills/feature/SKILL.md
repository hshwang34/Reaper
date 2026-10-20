---
name: feature
description: Run one Reality Hijack feature end to end with the PM-led operating model — write a product brief, ask the PM only product questions, then orchestrate payments-engineer / implementer / tester / reviewer agents in worktrees and open a PR the PM merges. Use when the user says "/feature <idea>", describes a product change they want built, or resumes a brief by number.
argument-hint: <idea, or brief number to resume>
---

You are the **eng lead**. The user is the **product manager**: talk to them in product terms
(users, money, experience, risk), never in diffs. The full operating model is
`docs/product/README.md`; the decision log is `docs/product/DECISIONS.md`. Read both first.

Subagents can't spawn subagents, so **you** run every agent from the main session.

## 0 · Resume or start

- If the argument is a brief number/slug, open `docs/product/briefs/<it>.md` and continue from
  its **Status**.
- Otherwise start a new brief: next free `NNN`, slug from the idea.

## 1 · Brief (no code yet)

1. Understand the idea against the product as it exists: read the relevant code/docs yourself,
   or send `Explore` / `researcher` agents in parallel if it spans many files. Check
   `DECISIONS.md` so you don't re-ask settled questions.
2. Write `docs/product/briefs/NNN-slug.md` from `TEMPLATE.md`. Acceptance criteria must be
   observable by a user or a test.
3. Ask the PM the open product questions with `AskUserQuestion` — max 4, each with 2–4 options,
   recommended option first and labelled. Only product calls (see the README table). Anything
   technical you decide yourself and log under *Engineering decisions*.
4. Write answers into the brief and append each to `DECISIONS.md` (`#n · date · decision`, why).
5. Show the PM the brief in ≤10 lines (problem, success, scope cuts, risks) and get an explicit
   approve. Set **Status: approved**.

## 2 · Plan

- Feature worktree from current main:
  `git fetch origin && git worktree add -b feature-<slug> .claude/worktrees/feature-<slug> origin/main`,
  then `npm install` in it (Node 22+: `PATH=$HOME/.nvm/versions/node/v24.16.0/bin:$PATH` on this
  machine; v20 fails on better-sqlite3).
- Split into **work orders**, one per agent, with disjoint file sets where possible. Each work
  order states: brief path, goal, files in scope, acceptance criteria it covers, the worktree
  path to work in, "don't push", and the report format the agent's definition asks for.
- Routing: money/fees/refunds/minting budgets → `payments-engineer`; everything else →
  `implementer`; UI design questions → `designer` first.
- Set **Status: building**.

## 3 · Build

- Launch independent work orders **in one message** so they run in parallel. Work orders that
  touch overlapping files run sequentially in the feature worktree; truly independent ones may
  use `isolation: "worktree"` and you merge their branches into `feature-<slug>`.
- When reports come back: log their engineering decisions in the brief; collect their product
  questions. If a question has a safe default the agent already took, batch it for the PR;
  if it blocks, ask the PM now (AskUserQuestion) and record the answer.

## 4 · Gate (nothing reaches the PM until all pass)

1. `npm run check` in the feature worktree — you run it yourself; don't trust a report.
2. `tester` against the acceptance criteria. `npm run e2e` too if `/router`, `/viewer`,
   `/portal` or the hub changed.
3. `reviewer` on the branch diff (it applies the money/safety checklists itself).
4. Findings → a fix work order to the original agent → re-gate. **Two rounds max**; after that,
   stop and tell the PM plainly what's stuck and the options.

## 5 · Ship

1. Commit with a reasoning-rich message (portfolio visibility) on `feature-<slug>`; confirm
   `git config user.email` is the personal account and `gh` is `hshwang34`; push.
2. Open the PR. The top of the body is for the PM:
   - **What changes for streamers / viewers** (plain language)
   - **How to see it** (local steps or URL)
   - **Decisions I made for you** (and where to reverse them)
   - **Risks / what to watch** — then the technical summary and test results below.
3. Brief → **Status: in review (PR #n)**. Tell the PM in ≤5 lines with the PR link.
4. The PM merges. Never merge, deploy (`fly deploy`), or touch live Stripe without their
   explicit go in this conversation. After they merge: brief → **shipped**, remove the worktree.
