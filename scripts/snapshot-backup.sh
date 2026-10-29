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
#   - Immutable per-run tags: after a successful push, push tag
#     snapshot-YYYYMMDD-HHMM (TZ Europe/Istanbul) pointing at the snapshot
#     commit. create-or-reuse: a tag that already exists on the remote is NEVER
#     moved — skipped when it already points at this commit, left untouched
#     (with an honest log) otherwise. (2026-10-29: the daily-only name left the
#     2nd+ pushes of a day unpinned — snapshot-20261029 stayed on the FIRST
#     commit while main advanced to b91a986, so the newest snapshot had no
#     restore pin of its own; minute-precision pins EVERY pushed snapshot.)
#   - Chain-metadata commit messages: second line carries files-changed vs the
#     previous snapshot tree (all change types — deletions count as changes; a
#     --diff-filter subset would understate the delta) + "scan:ok" from the
#     fail-closed scan that gated this run (scan precedes tree build; the deny-list
#     remains defense-in-depth).
#
# upload/ + download/ + db/ + ops/vault/ + tests/ + agent-ctx/ + PNGs NEVER leave the sandbox.
# Full local history (initial commit contains .env) stays private.
# Token: the GitHub connector (src/lib/connectors/github.ts) mirrors the token
# to ops/vault/github.token (0600, atomic) on EVERY successful store — web
# flow AND device flow — so this script always pushes with the live credential;
# never in argv/config/remote URL.
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
# younger than MIN_PUSH_GAP_S. Panel button + service /run land here; two
# documented bypasses exist (TIME-THROTTLE ONLY — dedupe, the fail-closed
# scan, the fast-forward push and the divergence pre-check ALWAYS apply):
#   NEXUS_BACKUP_FORCE=1        — reserved for the cadence service's 6h timer.
#   NEXUS_BACKUP_ORIGIN_PUSH=1 — /api/obs/publish-origin after a preview-origin
#                                rotation: the stable OBS bridge (obs.html on
#                                GitHub Pages) stays dead until the new origin
#                                reaches obs-target.json on main, so an origin
#                                publish may not sit out the 30-min window.
if [[ "${NEXUS_BACKUP_FORCE:-0}" != "1" && "${NEXUS_BACKUP_ORIGIN_PUSH:-0}" != "1" && -n "$S_OK_EPOCH" && "$S_OK_EPOCH" =~ ^[0-9]+$ ]]; then
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

# 2) fail-closed secret scan — EARLY pass on the repository index (R11:
# literal-only env pattern, tests/ out of set; index-guard catches platform
# re-tracking before any work is done). The AUTHORITATIVE pass runs in step 5.5
# against the exact push-set temp index — see the note there.
if ! bash scripts/secret-scan.sh; then
  log "ABORT: secret scan found hits — resolve before any push"
  S_RESULT="scan-failed"; S_AT="$TS"; state_flush
  exit 1
fi

# 2.5) GitHub Pages bridge hygiene (2026-10-26: first Pages enablement build
#      ERRORED with "Page build failed"). Root causes, all fixed here:
#      a) Jekyll: Pages (legacy build) runs Jekyll over the whole tree and the
#         snapshot carries worklog.md/docs with liquid-shaped {{ }} text —
#         Jekyll parse failure = failed build. .nojekyll (workspace root,
#         tracked) disables Jekyll: files are served exactly as pushed, which
#         is all a static snapshot repo needs.
#      b) Paths: the bridge promises /obs.html and fetches obs-target.json at
#         the repo ROOT, but the snapshot mirrors the workspace layout
#         (public/obs.html, public/obs-target.json) — both fetched URLs 404'd
#         by construction. Root-level copies are synced from public/ before
#         the tree build so
#         https://specimba.github.io/NEXUSbot/obs.html and its
#         raw.githubusercontent .../main/obs-target.json both resolve.
for BRIDGE_FILE in obs.html obs-target.json; do
  if [[ -f "public/$BRIDGE_FILE" ]]; then
    cmp -s "public/$BRIDGE_FILE" "$BRIDGE_FILE" || cp "public/$BRIDGE_FILE" "$BRIDGE_FILE"
  else
    rm -f "$BRIDGE_FILE"
  fi
done
touch .nojekyll

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
# 5.5) AUTHORITATIVE fail-closed scan of the EXACT push set (2026-10-26 22:49
#      +03 incident root fix). The step-2 scan reads the repository index — but
#      step 5 builds the tree from the WORKING TREE, so a brand-new file (the
#      owner's 21:08 seal) could ride the 21:42 push having never been
#      content-scanned: it entered the index only via step 3's `git add -A`,
#      AFTER the scan had already run. Scanning the temp index closes that hole
#      by construction — the scan set IS the push set, file for file. The
#      script's index-guard still pins to the real index (env -u), so this pass
#      cannot mask a platform-sync re-tracking regression.
if ! GIT_INDEX_FILE="$TMPIDX" bash scripts/secret-scan.sh; then
  unset GIT_INDEX_FILE
  log "ABORT: push-set secret scan found hits — resolve before any push"
  S_RESULT="scan-failed"; S_AT="$TS"; state_flush
  exit 1
fi
unset GIT_INDEX_FILE

# 6) skip when content unchanged (idempotent cadence runs).
#    G1 fix (2026-10-25): the old bare skip kept lastResult at the PREVIOUS
#    run's value — after the owner re-connected GitHub, the panel kept showing
#    the stale auth-failure (the skip fired before any push could test the new
#    token), which read as "still 401 after reconnect". Now a skip while
#    lastResult is not "ok" probes the stored credential with
#    `git push --dry-run` (full auth handshake; updates NOTHING on the remote):
#      probe OK    → lastResult:"ok" — stale failure cleared, auth verified
#                    (lastAt/head/tag/lastOkEpoch stay on the last REAL push)
#      auth reject → exit 4 with the exact rejection reason (branch below)
#      other error → plain skip; lastResult kept (a network hiccup is not
#                    fresh auth data; the next real push reports honestly)
if [[ -n "$BASE" && "$(git rev-parse "$BASE^{tree}" 2>/dev/null)" == "$TREE" ]]; then
  if [[ "$S_RESULT" != "ok" ]]; then
    if git push --dry-run "$REMOTE_URL" "$BRANCH:main" 2>>"$STATE_DIR/backup-log.txt"; then
      S_RESULT="ok"
      state_flush
      log "SKIP: snapshot content unchanged ($TREE) — push --dry-run auth probe OK: stored token accepted, stale failure cleared"
      exit 0
    elif tail -n 3 "$STATE_DIR/backup-log.txt" | grep -qi "invalid username or token\|authentication failed"; then
      S_RESULT="failed"; S_AT="$TS"; state_flush
      log "PUSH FAILED — GitHub rejected the stored token (expired/revoked). Re-connect GitHub in Connectors, then run again; the snapshot chain itself is healthy."
      exit 4
    elif tail -n 3 "$STATE_DIR/backup-log.txt" | grep -qi "write access to repository not granted\|resource not accessible\|403"; then
      S_RESULT="failed"; S_AT="$TS"; state_flush
      log "PUSH FAILED — token lacks repo scope — reconnect GitHub in Connectors (the fresh OAuth grant must include repo/public_repo), then run again."
      exit 4
    else
      log "SKIP: snapshot content unchanged ($TREE) — auth probe did not verify (non-auth failure, see log above); keeping lastResult=$S_RESULT"
      state_flush
      exit 0
    fi
  fi
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
  # 2026-10-25 lesson: a dead GitHub token ("Invalid username or token") used to be
  # mislabeled "non-fast-forward", sending the owner chasing a divergence that
  # did not exist. Name the auth failure honestly (22:59 incident) — and (G1)
  # separate the TWO distinct rejections: a dead/revoked token vs a token
  # without push scope, each with its own remedy.
  if tail -n 3 "$STATE_DIR/backup-log.txt" | grep -qi "invalid username or token\|authentication failed"; then
    log "PUSH FAILED — GitHub rejected the stored token (expired/revoked). Re-connect GitHub in Connectors, then run again; the snapshot chain itself is healthy."
  elif tail -n 3 "$STATE_DIR/backup-log.txt" | grep -qi "write access to repository not granted\|resource not accessible\|403"; then
    log "PUSH FAILED — token lacks repo scope — reconnect GitHub in Connectors (the fresh OAuth grant must include repo/public_repo), then run again."
  else
    log "PUSH FAILED — non-fast-forward (owner edited remote?) → resolve manually; no force push per directive"
  fi
  S_RESULT="failed"; S_AT="$TS"; state_flush
  exit 4
fi

# 11) immutable per-run tag (12-d, re-timed 2026-10-29): snapshot-YYYYMMDD-HHMM
#     in Europe/Istanbul at the snapshot commit. Daily-only tags left the 2nd+
#     pushes of a day unpinned (the tag stayed on the first snapshot while main
#     moved on) — minute-precision gives EVERY pushed snapshot its own pin.
#     create-or-reuse — a tag already on the remote is NEVER moved: skip when it
#     already points here; leave untouched (honest log) when it points elsewhere.
#     A tag-push failure does not fail the run (the snapshot itself is already
#     pushed; the next run retries the tag).
TAG="snapshot-$(TZ=$TZENV date +%Y%m%d-%H%M)"
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
