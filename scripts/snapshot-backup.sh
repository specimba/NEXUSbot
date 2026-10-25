#!/usr/bin/env bash
# NEXUS OS — sanitized snapshot backup → github.com/specimba/NEXUSbot (public, owner-approved).
# Design (docs/research.md D3, R11-hardened, 12-d hardening): squash-snapshot chain on
# branch `public-snapshot`, seeded on top of the owner's remote main initial commit,
# pushed FAST-FORWARD ONLY behind a remote-divergence pre-check.
#
# 12-d hardening (10-b durability review):
#   - 30-min push throttle: a run whose last SUCCESSFUL push was < MIN_PUSH_GAP_S ago
#     exits 0 with an honest "SKIP: throttled" line (state still records lastAttemptAt).
#     NEXUS_BACKUP_FORCE=1 bypasses the throttle — reserved for the backup-cadence
#     service's own 6h timer (boot/interval). The panel button (POST /api/backup/run)
#     and the service's /run endpoint never set it: they go through the throttle.
#     A forced run is still content-gated (unchanged tree → SKIP) — force only skips
#     the TIME throttle, never the dedupe or the scan.
#   - Remote-divergence pre-check before every push: fetch remote main (depth 1) and
#     require the remote head to be an ancestor-or-equal of the local chain head
#     (`git merge-base --is-ancestor FETCH_HEAD <local head>` — that direction is what
#     makes our push a fast-forward). Otherwise: state lastResult:"diverged", exit 5.
#     No force push, ever (§8). If the pre-check fetch itself fails we proceed WITHOUT
#     it — the push stays fast-forward-only, so the worst case is an honest rejection
#     (exit 4), never a rewritten remote chain.
#   - Immutable daily tags: after a successful push, push tag snapshot-YYYYMMDD
#     (TZ Europe/Istanbul) pointing at the snapshot commit. create-or-reuse: a tag
#     that already exists on the remote is NEVER moved — skipped when it already
#     points at this commit, left untouched (with an honest log) otherwise.
#   - Chain-metadata commit messages: second line carries files-changed vs the
#     previous snapshot tree (all change types — deletions count as changes; a
#     --diff-filter subset would understate the delta) + "scan:ok" from the
#     fail-closed scan that gated this run (scan precedes tree build; the deny-list
#     remains defense-in-depth).
#
# upload/ + download/ + db/ + ops/vault/ + tests/ + agent-ctx/ + PNGs NEVER leave the sandbox.
# Full local history (initial commit contains .env) stays private.
# Token arrives via device-flow watcher at ops/vault/github.token; never in argv/config/remote URL.
set -uo pipefail
cd "$(dirname "$0")/.."

TZENV="Europe/Istanbul"
TS=$(TZ=$TZENV date '+%Y-%m-%d %H:%M %Z')
NOW_EPOCH=$(date +%s)
STATE_DIR=".zscripts"
STATE_FILE="$STATE_DIR/backup-state.json"
TOKEN_FILE="ops/vault/github.token"
REMOTE_URL="https://github.com/specimba/NEXUSbot.git"
BRANCH="public-snapshot"
MIN_PUSH_GAP_S=1800  # 30-min push throttle (10-b review); NEXUS_BACKUP_FORCE=1 bypasses
mkdir -p "$STATE_DIR" ops/vault

# Outcome lines go to BOTH the log file and stdout: the panel run route (and
# the cadence service) detect SKIP/throttled outcomes from stdout — keeping
# them /dev/null-silent made a throttled run indistinguishable from a push
# (12-d verification caught the panel reporting "Snapshot pushed" for a run
# that had honestly skipped). No secret ever appears in these lines (P7).
log() { echo "[backup $TS] $*" | tee -a "$STATE_DIR/backup-log.txt"; }

# --- state (.zscripts/backup-state.json) ------------------------------------
# Flat JSON, updated field-wise: a throttled/failed attempt stamps lastAttempt*
# but never erases lastResult/head/tag of the last real outcome. Epochs are
# unix seconds so the throttle is TZ-independent; the human-readable stamps are
# kept for the panel card.
state_get() { # $1=key → value (quoted or bare JSON scalar), "" when absent
  [[ -f "$STATE_FILE" ]] || return 0
  # Capture class [^,"}]: stops at value end for BOTH quoted strings and bare
  # numbers — a greedy [^"]* would swallow the trailing comma after a bare
  # epoch (12-d verification caught exactly that: the numeric guard then failed
  # open and the 30-min throttle never fired).
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" "$STATE_FILE" | tail -1
}
S_RESULT=$(state_get lastResult)   # last real outcome (ok|failed|scan-failed|diverged|…)
S_AT=$(state_get lastAt)           # timestamp of that outcome
S_OK_EPOCH=$(state_get lastOkEpoch)
S_HEAD=$(state_get head)
S_TAG=$(state_get tag)
S_ATTEMPT=$(state_get lastAttemptAt)
S_ATTEMPT_EPOCH=$(state_get lastAttemptEpoch)
state_flush() {
  printf '{"lastResult":"%s","lastAt":"%s","lastOkEpoch":%s,"head":"%s","tag":"%s","lastAttemptAt":"%s","lastAttemptEpoch":%s}\n' \
    "$S_RESULT" "$S_AT" "${S_OK_EPOCH:-null}" "$S_HEAD" "$S_TAG" "$S_ATTEMPT" "${S_ATTEMPT_EPOCH:-null}" \
    > "$STATE_FILE"
}

# 0) anti-hammering bookkeeping: EVERY invocation stamps lastAttempt* first.
S_ATTEMPT="$TS"; S_ATTEMPT_EPOCH="$NOW_EPOCH"

# 0.1) push throttle (12-d): skip honestly when the last successful push is
# younger than MIN_PUSH_GAP_S. Panel button + service /run land here; only the
# cadence service's 6h timer (NEXUS_BACKUP_FORCE=1) may bypass it.
if [[ "${NEXUS_BACKUP_FORCE:-0}" != "1" && -n "$S_OK_EPOCH" && "$S_OK_EPOCH" =~ ^[0-9]+$ ]]; then
  ELAPSED=$((NOW_EPOCH - S_OK_EPOCH))
  if [[ $ELAPSED -ge 0 && $ELAPSED -lt $MIN_PUSH_GAP_S ]]; then
    log "SKIP: throttled — last successful push ${ELAPSED}s ago (< ${MIN_PUSH_GAP_S}s min-gap); NEXUS_BACKUP_FORCE=1 is reserved for the 6h cadence timer"
    state_flush
    exit 0
  fi
fi
state_flush

# 1) token present?
if [[ ! -s "$TOKEN_FILE" ]]; then
  log "NO_TOKEN: device flow not completed yet (open the panel durability tile)"
  exit 3
fi

# 1.5) askpass helper — token reaches git via askpass only (never argv/remote URL/config)
cat > ops/vault/askpass.sh <<'AP'
#!/bin/bash
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) cat "$(dirname "$0")/github.token" ;;
esac
AP
chmod 700 ops/vault/askpass.sh
export GIT_ASKPASS="$PWD/ops/vault/askpass.sh" GIT_TERMINAL_PROMPT=0

# 2) fail-closed secret scan (R11: literal-only env pattern, tests/ out of set)
if ! bash scripts/secret-scan.sh; then
  log "ABORT: secret scan found hits — resolve before any push"
  S_RESULT="scan-failed"; S_AT="$TS"; state_flush
  exit 1
fi

# 3) commit dirty tracked work (local history; P8 commit cadence)
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  git commit -q -m "chore(backup): auto-snapshot $TS" || true
fi

# 4) snapshot base: local chain head; else seed from remote main (first run — never force)
BASE=$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)
if [[ -z "$BASE" ]]; then
  if git fetch --depth=1 "$REMOTE_URL" main >/dev/null 2>>"$STATE_DIR/backup-log.txt"; then
    BASE=$(git rev-parse FETCH_HEAD)
    log "seeding snapshot chain from remote main @ ${BASE:0:12}"
  else
    log "remote main fetch failed; building standalone chain"
  fi
fi

# 5) build sanitized tree via temp index (plumbing only — dev server undisturbed).
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
  ':(exclude).next' \
  ':(exclude).env' \
  ':(exclude).zscripts/dev.pid' \
  ':(exclude,glob).zscripts/*.pid' \
  ':(exclude,glob).zscripts/*.log' \
  ':(exclude).zscripts/backup-log.txt' \
  ':(exclude).zscripts/backup-state.json' \
  ':(exclude,glob)**/*.png' \
  ':(exclude,glob)**/*.db' \
  ':(exclude,glob)**/*.sqlite' \
  ':(exclude,glob)**/*.tar' \
  ':(exclude,glob)**/*.log' \
  ':(exclude,glob)**/*.tsbuildinfo'
TREE=$(git write-tree)
unset GIT_INDEX_FILE

# 6) skip when content unchanged (idempotent cadence runs)
if [[ -n "$BASE" && "$(git rev-parse "$BASE^{tree}" 2>/dev/null)" == "$TREE" ]]; then
  log "SKIP: snapshot content unchanged ($TREE)"
  exit 0
fi

# 7) chain-metadata: files changed vs the previous snapshot tree (all change
#    types; deletions count as changes) for the commit's metadata line.
if [[ -n "$BASE" ]]; then
  FILES_CHANGED=$(( $(git diff-tree -r --name-only "$BASE" "$TREE" | wc -l) ))
else
  FILES_CHANGED=$(( $(git ls-tree -r --name-only "$TREE" | wc -l) ))
fi

# 8) extend the chain (parent = previous snapshot or seeded remote head)
if [[ -n "$BASE" ]]; then
  COMMIT=$(git commit-tree "$TREE" -p "$BASE" \
    -m "snapshot: $TS

files-changed: $FILES_CHANGED vs ${BASE:0:12}; scan:ok")
else
  COMMIT=$(git commit-tree "$TREE" \
    -m "snapshot: $TS (initial sanitized snapshot)

files-changed: $FILES_CHANGED; scan:ok")
fi
git update-ref "refs/heads/$BRANCH" "$COMMIT"
log "built snapshot commit ${COMMIT:0:12} (tree ${TREE:0:12}, files-changed $FILES_CHANGED)"

# 9) remote-divergence pre-check (12-d): the push is only ever fast-forward, so
#    the REMOTE head must be an ancestor-or-equal of our local chain head. If
#    remote main moved on its own (owner edit / another machine), refuse with
#    exit 5 + lastResult:"diverged" — resolution is manual, no force push (§8).
if git fetch --depth=1 "$REMOTE_URL" main >/dev/null 2>>"$STATE_DIR/backup-log.txt"; then
  REMOTE_HEAD=$(git rev-parse FETCH_HEAD)
  if git merge-base --is-ancestor "$REMOTE_HEAD" "$COMMIT"; then
    log "divergence pre-check OK — remote main ${REMOTE_HEAD:0:12} is ancestor/equal of local head"
  else
    S_RESULT="diverged"; S_AT="$TS"; state_flush
    log "DIVERGED: remote main ${REMOTE_HEAD:0:12} is NOT an ancestor of local chain head ${COMMIT:0:12} — push refused (no force push, §8); resolve the remote manually"
    exit 5
  fi
else
  # Fail-open is safe here: the push itself stays fast-forward-only, so a missed
  # pre-check can never rewrite the remote chain — worst case exit 4 (rejected).
  log "divergence pre-check unavailable (fetch failed) — proceeding; push remains fast-forward-only"
fi

# 10) push fast-forward only; on failure resolve manually — no force push per §8
if git push "$REMOTE_URL" "$BRANCH:main" 2>>"$STATE_DIR/backup-log.txt"; then
  S_RESULT="ok"; S_AT="$TS"; S_OK_EPOCH="$NOW_EPOCH"; S_HEAD="$COMMIT"
  log "PUSH OK → specimba/NEXUSbot main @ ${COMMIT:0:12}"
else
  S_RESULT="failed"; S_AT="$TS"; state_flush
  log "PUSH FAILED — non-fast-forward (owner edited remote?) → resolve manually; no force push per directive"
  exit 4
fi

# 11) immutable daily tag (12-d): snapshot-YYYYMMDD in Europe/Istanbul at the
#     snapshot commit. create-or-reuse — a tag already on the remote is NEVER
#     moved: skip when it already points here; leave untouched (honest log)
#     when it points elsewhere. A tag-push failure does not fail the run (the
#     snapshot itself is already pushed; the next run retries the tag).
TAG="snapshot-$(TZ=$TZENV date +%Y%m%d)"
REMOTE_TAG=$(git ls-remote --tags "$REMOTE_URL" "refs/tags/$TAG" 2>>"$STATE_DIR/backup-log.txt" | cut -f1 | head -1)
if [[ -z "$REMOTE_TAG" ]]; then
  # Remote does not have the tag → re-pointing a stale local tag is safe (the
  # immutability contract only covers the remote).
  git tag -f "$TAG" "$COMMIT" 2>>"$STATE_DIR/backup-log.txt"
  if git push "$REMOTE_URL" "refs/tags/$TAG" 2>>"$STATE_DIR/backup-log.txt"; then
    S_TAG="$TAG"
    log "TAG OK → $TAG @ ${COMMIT:0:12}"
  else
    log "TAG PUSH FAILED for $TAG — snapshot itself is pushed; the next run will retry the tag"
  fi
elif [[ "$REMOTE_TAG" == "$COMMIT" ]]; then
  S_TAG="$TAG"
  log "TAG $TAG already on remote at this commit — create-or-reuse"
else
  log "TAG $TAG already exists on remote at ${REMOTE_TAG:0:12} (≠ ${COMMIT:0:12}) — left untouched (tags are immutable)"
fi

state_flush
exit 0
