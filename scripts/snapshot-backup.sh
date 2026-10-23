#!/usr/bin/env bash
# NEXUS OS — sanitized snapshot backup → github.com/specimba/NEXUSbot (public, owner-approved).
# Design (docs/research.md D3, R11-hardened): squash-snapshot chain on branch `public-snapshot`,
# seeded on top of the owner's remote main initial commit, pushed FAST-FORWARD ONLY.
# upload/ + download/ + db/ + ops/vault/ + tests/ + agent-ctx/ + PNGs NEVER leave the sandbox.
# Full local history (initial commit contains .env) stays private. No --force push, ever (§8).
# Token arrives via device-flow watcher at ops/vault/github.token; never in argv/config/remote URL.
set -uo pipefail
cd "$(dirname "$0")/.."

TZENV="Europe/Istanbul"
TS=$(TZ=$TZENV date '+%Y-%m-%d %H:%M %Z')
STATE_DIR=".zscripts"
TOKEN_FILE="ops/vault/github.token"
REMOTE_URL="https://github.com/specimba/NEXUSbot.git"
BRANCH="public-snapshot"
mkdir -p "$STATE_DIR" ops/vault

log() { echo "[backup $TS] $*" | tee -a "$STATE_DIR/backup-log.txt" >/dev/null; }

# 0) token present?
if [[ ! -s "$TOKEN_FILE" ]]; then
  log "NO_TOKEN: device flow not completed yet (open the panel durability tile)"
  exit 3
fi

# 0.5) askpass helper — token reaches git via askpass only (never argv/remote URL/config)
cat > ops/vault/askpass.sh <<'AP'
#!/bin/bash
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) cat "$(dirname "$0")/github.token" ;;
esac
AP
chmod 700 ops/vault/askpass.sh
export GIT_ASKPASS="$PWD/ops/vault/askpass.sh" GIT_TERMINAL_PROMPT=0

# 1) fail-closed secret scan (R11: literal-only env pattern, tests/ out of set)
if ! bash scripts/secret-scan.sh; then
  log "ABORT: secret scan found hits — resolve before any push"
  printf '{"lastResult":"scan-failed","lastAt":"%s"}\n' "$TS" > "$STATE_DIR/backup-state.json"
  exit 1
fi

# 2) commit dirty tracked work (local history; P8 commit cadence)
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -q -m "chore(backup): auto-snapshot $TS" || true
fi

# 3) snapshot base: local chain head; else seed from remote main (first run — never force)
BASE=$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)
if [[ -z "$BASE" ]]; then
  if git fetch --depth=1 "$REMOTE_URL" main >/dev/null 2>>"$STATE_DIR/backup-log.txt"; then
    BASE=$(git rev-parse FETCH_HEAD)
    log "seeding snapshot chain from remote main @ ${BASE:0:12}"
  else
    log "remote main fetch failed; building standalone chain"
  fi
fi

# 4) build sanitized tree via temp index (plumbing only — dev server undisturbed).
# Deny-list is defense-in-depth: db/ + vault + notes + harness NEVER enter the snapshot
# even if .gitignore is ever edited (verify-core incident lesson: fail closed).
TMPIDX=$(mktemp)
trap 'rm -f "$TMPIDX"' EXIT
export GIT_INDEX_FILE="$TMPIDX"
if [[ -n "$BASE" ]]; then git read-tree "$BASE"; else git read-tree --empty; fi
git add -A -- . \
  ':(exclude)upload' \
  ':(exclude)download' \
  ':(exclude)db' \
  ':(exclude)ops/vault' \
  ':(exclude)tool-results' \
  ':(exclude)agent-ctx' \
  ':(exclude)directives' \
  ':(exclude)tests' \
  ':(exclude).zscripts/dev.pid' \
  ':(exclude).zscripts/backup-log.txt' \
  ':(exclude).zscripts/backup-state.json' \
  ':(exclude,glob)**/*.png' \
  ':(exclude,glob)**/*.db' \
  ':(exclude,glob)**/*.sqlite' \
  ':(exclude,glob)**/*.tar' \
  ':(exclude,glob)**/*.log'
TREE=$(git write-tree)
unset GIT_INDEX_FILE

# 5) skip when content unchanged (idempotent cadence runs)
if [[ -n "$BASE" && "$(git rev-parse "$BASE^{tree}" 2>/dev/null)" == "$TREE" ]]; then
  log "SKIP: snapshot content unchanged ($TREE)"
  exit 0
fi

# 6) extend the chain (parent = previous snapshot or seeded remote head)
if [[ -n "$BASE" ]]; then
  COMMIT=$(git commit-tree "$TREE" -p "$BASE" -m "snapshot: $TS")
else
  COMMIT=$(git commit-tree "$TREE" -m "snapshot: $TS (initial sanitized snapshot)")
fi
git update-ref "refs/heads/$BRANCH" "$COMMIT"
log "built snapshot commit ${COMMIT:0:12} (tree ${TREE:0:12})"

# 7) push fast-forward only; on failure resolve manually — no force push per §8
if git push "$REMOTE_URL" "$BRANCH:main" 2>>"$STATE_DIR/backup-log.txt"; then
  printf '{"lastResult":"ok","lastAt":"%s","head":"%s"}\n' "$TS" "$COMMIT" > "$STATE_DIR/backup-state.json"
  log "PUSH OK → specimba/NEXUSbot main @ ${COMMIT:0:12}"
else
  printf '{"lastResult":"failed","lastAt":"%s"}\n' "$TS" > "$STATE_DIR/backup-state.json"
  log "PUSH FAILED — non-fast-forward (owner edited remote?) → resolve manually; no force push per directive"
  exit 4
fi
