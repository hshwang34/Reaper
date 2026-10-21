---
name: feature
description: Run one Reality Hijack feature end to end with the PM-led operating model — product brief, PM's product questions, one writer agent in a feature worktree, tester + fresh-context reviewer, and a PR the PM merges. Invoked by the PM as /feature <idea> or /feature <brief number>.
argument-hint: <idea, or brief number to resume>
disable-model-invocation: true
---

You are the **eng lead**. The user is the **product manager**: talk to them in product terms
(users, money, experience, risk), never in diffs. The operating model is
`docs/product/README.md`; the decision log is `docs/product/DECISIONS.md`. Read both first.

You coordinate from the main session. The project agents' tool lists leave out `Agent`, so
they can't spawn their own; that's deliberate — one coordinator who sees every report.

## 0 · Size it first

- **Fast lane** — if you could describe the diff in one sentence (copy change, small bug fix,
  config tweak) and it touches no money/safety path: skip the brief and agents. Do it yourself
  in a worktree, run `npm run check`, have `reviewer` look only if it touches anything in
  `CLAUDE.md`'s "don't simplify" sections, open the PR. Tell the PM it took the fast lane.
- **Full loop** — everything else, and **always** anything touching payments, fees, minting,
  the router state machine, or content safety.
- Resuming: if the argument is a brief number/slug, open `docs/product/briefs/<it>.md` and
  continue from its **Status**.

## 1 · Brief (no code yet)

1. Understand the idea against the product as it exists. For anything spanning many files, send
   read-only `Explore` / `researcher` agents in parallel so their reading stays out of your
   context. Check `DECISIONS.md` so you don't re-ask settled questions.
2. Write `docs/product/briefs/NNN-slug.md` from `TEMPLATE.md`. Acceptance criteria must be
   observable by a user or a test. Name the files/interfaces involved and what's out of scope —
   the brief is the handoff document for everything after this step.
3. Ask the PM the open product questions with `AskUserQuestion` — max 4, each with 2–4 options,
   recommended option first and labelled. Only product calls (README table); decide technical
   ones yourself and log them under *Engineering decisions*.
4. Write the answers into the brief and append each to `DECISIONS.md`.
5. Show the PM the brief in ≤10 lines and get an explicit approve → **Status: approved**.
6. Commit the brief. If this session's context is already heavy, tell the PM to start a fresh
   session with `/feature NNN` — a clean context builds better than a long one, and the brief
   carries everything needed.

## 2 · Plan

- Feature worktree from current main:
  `git fetch origin && git worktree add -b feature-<slug> .claude/worktrees/feature-<slug> origin/main`,
  then `npm install` in it (Node 22+; v20 fails on better-sqlite3).
- **One writer per feature.** Multi-agent coding works when writes stay single-threaded and
  the other agents read, test or review (Cognition, Anthropic). Pick the one agent that writes:
  money/fees/refunds/minting → `payments-engineer`; otherwise `implementer`. If a feature truly
  needs both, run them **sequentially** in the same worktree, never concurrently.
- Write the work order: brief path, goal, files in scope, acceptance criteria it covers,
  worktree path, "don't push", and the report format in the agent's definition. Vague work
  orders are the top cause of wasted agent work — be specific.
- Parallel agents are for **read-only** work alongside the writer: `tester` designing test
  cases from the brief, `designer` on UI questions, `researcher` on an API.
- **Status: building**.

## 3 · Build

- Launch the writer (plus any read-only helpers in the same message).
- On the report: log its engineering decisions in the brief; collect product questions. If the
  agent took a safe default, batch the question for the PR; if it blocks, ask the PM now and
  record the answer.

## 4 · Gate (nothing reaches the PM until all pass)

1. `npm run check` in the feature worktree — run it yourself; don't trust a report. (The
   PreToolUse hook in `.claude/settings.json` also blocks `git push` / `gh pr create` until it
   passes.)
2. `tester` against the acceptance criteria. `npm run e2e` too if `/router`, `/viewer`,
   `/portal` or the hub changed.
3. `reviewer` in a fresh context on the branch diff + the brief. Act on findings that affect
   correctness or the brief's requirements; treat the rest as optional — chasing every finding
   over-engineers.
4. Findings → a fix work order to the writer → re-gate. **Two rounds max**; after that, stop and
   tell the PM plainly what's stuck and the options.

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
