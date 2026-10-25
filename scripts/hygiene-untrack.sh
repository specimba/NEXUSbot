#!/usr/bin/env bash
# NEXUS OS — idempotent local-git hygiene (R14).
#
# WHY THIS EXISTS: the sandbox platform's own sync process periodically commits
# the whole workspace with a UUID message (author "Z User <z@container>"). That
# process REPLACES .gitignore with a 2-line template and `git add -A`s
# everything — re-tracking .env, .next/ (600+ build files), db/custom.db,
# upload/, tool-results/, agent-ctx/, pid/log/state files into LOCAL history.
#
# What that endangers (measured 2026-10-23, commit 544a129):
#   - .env + db/custom.db: encryption key + encrypted vault in one repo.
#   - .next/: ~20 MB of build junk that would be pushed to the PUBLIC snapshot
#     repo (it was in NO deny-list before R14).
# The public repo itself stayed clean that day ONLY because the secret-scan
# index-guard failed closed (.env tracked → scan abort → push blocked).
#
# WHAT THIS SCRIPT DOES (idempotent — safe to re-run any time):
#   1. Restores the hardened .gitignore from the local git history (R11+R14
#      version) when the platform's 2-line template is detected.
#   2. Untracks (git rm --cached, working files untouched) every forbidden
#      category: .env, .next/, db/, ops/vault/, upload/, download/,
#      tool-results/, agent-ctx/, directives/, *.tsbuildinfo, *.pid, *.log,
#      backup state files.
#   3. Commits the hygiene restoration locally (local history is never pushed
#      directly — the public chain is built from the sanitized snapshot tree).
#   4. Verifies with scripts/secret-scan.sh (the same fail-closed gate the
#      snapshot push uses) — exit non-zero if anything forbidden remains
#      tracked.
#
# P7: untracking only touches the git INDEX. No file contents are printed.
set -uo pipefail
cd "$(dirname "$0")/.."

# 1) restore the hardened .gitignore if the platform template gutted it
if [[ $(grep -vc '^\s*$' .gitignore 2>/dev/null || echo 0) -lt 5 ]]; then
  GOOD_REF=""
  for ref in HEAD HEAD~1 HEAD~2 HEAD~3 HEAD~4 HEAD~5; do
    if git show "$ref:.gitignore" 2>/dev/null | grep -q "R11 durability hardening"; then
      GOOD_REF="$ref"; break
    fi
  done
  if [[ -n "$GOOD_REF" ]]; then
    git show "$GOOD_REF:.gitignore" > .gitignore
    echo "[hygiene] restored hardened .gitignore from $GOOD_REF"
  else
    echo "[hygiene] WARNING: no hardened .gitignore found in recent history — leaving as-is" >&2
  fi
fi

# 2) untrack forbidden categories (index only; --cached; ignore misses)
UNTRACKED=()
# G1 fix (2026-10-25): the old `git ls-files "$path" | grep -q .` check failed
# OPEN under `set -o pipefail` for LARGE listings — grep -q exits at the first
# match, git dies of SIGPIPE (141), the pipeline reads non-zero and the path is
# skipped un-untracked (measured: .next/ with 1626 tracked files survived a
# run). Capture the listing instead of trusting the exit status.
for path in .env .next db ops/vault upload download tool-results agent-ctx directives; do
  if [[ -n "$(git ls-files -- "$path")" ]]; then
    git rm -r -q --cached "$path" >/dev/null 2>&1 || true
    UNTRACKED+=("$path")
  fi
done
# glob categories
for pat in '*.tsbuildinfo' '*.pid' '*.log' 'db/*.db' '*.db' '*.sqlite' '*.tar'; do
  hits=$(git ls-files -- "$pat" | grep . || true)
  if [[ -n "$hits" ]]; then
    # shellcheck disable=SC2086
    git rm -q --cached $hits >/dev/null 2>&1 || git rm -r -q --cached $hits >/dev/null 2>&1 || true
    UNTRACKED+=("$pat")
  fi
done
# snapshot state files
for f in .zscripts/backup-state.json .zscripts/backup-log.txt; do
  if [[ -n "$(git ls-files -- "$f")" ]]; then
    git rm -q --cached "$f" >/dev/null 2>&1 || true
    UNTRACKED+=("$f")
  fi
done

if [[ ${#UNTRACKED[@]} -eq 0 ]]; then
  echo "[hygiene] nothing to untrack — index already clean"
else
  echo "[hygiene] untracked: ${UNTRACKED[*]}"
fi

# 3) commit the restoration locally when the index changed
if ! git diff --cached --quiet; then
  git commit -q -m "chore(hygiene): untrack platform-sync junk, restore hardened .gitignore (R14 guard)" \
    && echo "[hygiene] committed restoration locally"
else
  echo "[hygiene] no index changes to commit"
fi

# 4) fail-closed verification — the same gate the snapshot push uses
if bash scripts/secret-scan.sh; then
  echo "[hygiene] scan gate OK — snapshot pushes are unblocked"
  exit 0
else
  echo "[hygiene] SCAN GATE STILL BLOCKED — forbidden paths remain tracked; resolve manually" >&2
  exit 1
fi
