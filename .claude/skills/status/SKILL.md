---
name: status
description: PM-level status of Reality Hijack work — every product brief and its state, open PRs, active worktrees, and what's waiting on the PM's decision or merge. Use when the user says "/status", "where are we", "what's in flight", or "what do you need from me".
---

Report for the **product manager**, not an engineer. Gather, then summarize:

1. `docs/product/briefs/*.md` (skip `TEMPLATE.md`): number, name, **Status** line, unanswered
   *Open product questions*.
2. `git fetch -q origin`; `gh pr list --state open --json number,title,headRefName,isDraft,statusCheckRollup`
   (as `hshwang34`), and PRs merged in the last 7 days.
3. `git worktree list` — flag worktrees whose branch is merged or gone (cleanup candidates),
   and dirty ones.
4. The last few entries of `docs/product/DECISIONS.md`.

Output, in this order and briefly:

- **Waiting on you** — PRs to merge (with one-line "what it does for users"), unanswered product
  questions, briefs awaiting approval. This is the only section that asks for action.
- **In flight** — what's being built and the next step.
- **Shipped recently** — product-level one-liners.
- **Housekeeping** — stale worktrees/branches (offer to clean up; don't delete without a yes).

No diffs, no file lists, no test logs unless something is failing — then one line saying what's
broken and what you propose.
