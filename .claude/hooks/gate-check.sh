#!/usr/bin/env bash
# PreToolUse gate: `npm run check` must pass before code leaves the machine.
#
# Wired in .claude/settings.json to `git push` and `gh pr create`. A CLAUDE.md
# rule ("run the check before a PR") is advisory; this is the deterministic
# version, so nothing reaches the PM's review queue red. Exit 2 blocks the
# tool call and hands stderr back to Claude as the reason.

set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')

# The `if` filters in settings.json are best-effort; re-check here.
case "$cmd" in
  *"git push"* | *"gh pr create"*) ;;
  *) exit 0 ;;
esac

# Gate the checkout the command runs in (a worktree, usually), not the
# session's start directory.
root=$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/package.json" ] || exit 0

# better-sqlite3 has no Node 20 prebuild; prefer an installed Node >= 22.
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 22 ]; then
  for d in $(ls -d "$HOME"/.nvm/versions/node/v2[2-9]* 2>/dev/null | sort -V -r); do
    PATH="$d/bin:$PATH"
    break
  done
fi

if [ ! -d "$root/node_modules" ]; then
  echo "gate: $root has no node_modules — run npm install there, then retry." >&2
  exit 2
fi

log=$(mktemp)
if (cd "$root" && npm run check) >"$log" 2>&1; then
  rm -f "$log"
  exit 0
fi

{
  echo "gate: npm run check failed in $root — fix it before pushing or opening a PR."
  echo "--- last 40 lines ---"
  tail -40 "$log"
} >&2
rm -f "$log"
exit 2
