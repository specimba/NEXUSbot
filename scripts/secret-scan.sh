#!/usr/bin/env bash
# NEXUS OS — fail-closed secret scanner (runs before any public push).
# Scans the sanitized snapshot file set. Exit 1 on ANY hit.
# P7: on a hit, print file:line + pattern name + masked prefix ONLY — never full values.
set -uo pipefail
cd "$(dirname "$0")/.."

# Scan set: the repository index by default. snapshot-backup.sh may export
# GIT_INDEX_FILE pointing at the temp index holding the EXACT tree it is about
# to push — `git ls-files` honors it automatically, so the authoritative
# pre-push scan covers files that are not tracked yet in the real index
# (2026-10-26 incident: the owner's fresh .seal file was pushed at 21:42
# UNSCANNED because the old scan ran before `git add -A` ever saw it).
#
# The index-guard below ALWAYS runs against the REAL repository index —
# a temp-index invocation must never bypass the platform-sync re-tracking guard.

# Double-guard: refuse to run if any forbidden path is still INDEXED (tracked).
# R14: extended after the platform sync process gutted .gitignore and re-tracked
# .env/.next/db/upload — the guard is what fail-closed the whole chain that day.
#
# G1 fix (2026-10-25): capture the hits instead of trusting a pipeline exit
# status (set -o pipefail + grep -q once let SIGPIPE turn the guard into dead
# code — measured 1723 forbidden index paths present, guard passed).
FORBIDDEN_INDEX_HITS=$(env -u GIT_INDEX_FILE git ls-files 2>/dev/null | grep -E '^(\.env|\.next/|db/|ops/vault/|upload/|tool-results/|agent-ctx/)|\.db$|\.tsbuildinfo$' || true)
if [[ -n "$FORBIDDEN_INDEX_HITS" ]]; then
  echo "SECRET-HIT [index-guard] forbidden path still tracked ($(printf '%s\n' "$FORBIDDEN_INDEX_HITS" | wc -l) paths) — run scripts/hygiene-untrack.sh; sample:"
  printf '%s\n' "$FORBIDDEN_INDEX_HITS" | head -5 | sed 's/^/  /'
  exit 1
fi

# R11 hardening: also deny db/vault/artifact dirs and binary/db artifacts outright.
FILES=$(git ls-files \
  | grep -vE '^(upload|download|db|ops/vault|tool-results|agent-ctx|directives|tests|\.next)/' \
  | grep -vE '\.(png|db|sqlite|tar|log|tsbuildinfo)$')

# Stronger guarantee for authoritative (temp-index) invocations: the push set
# is built with explicit excludes — if a forbidden path made it into the TEMP
# index anyway, that is an exclude-list regression and must abort, not skip.
if [[ -n "${GIT_INDEX_FILE:-}" ]]; then
  BAD_PUSH_PATHS=$(git ls-files | grep -E '^(\.env|\.next/|db/|ops/vault/|upload/|tool-results/|agent-ctx/|directives/|tests/)|\.db$|\.sqlite$|\.tsbuildinfo$|\.png$|\.tar$|\.log$' || true)
  if [[ -n "$BAD_PUSH_PATHS" ]]; then
    echo "SECRET-HIT [push-set-guard] forbidden path present in the push set ($(printf '%s\n' "$BAD_PUSH_PATHS" | wc -l) paths):"
    printf '%s\n' "$BAD_PUSH_PATHS" | head -5 | sed 's/^/  /'
    exit 1
  fi
fi

if [[ -z "$FILES" ]]; then echo "SCAN: no files"; exit 0; fi

# --- Seal envelope exemption (2026-10-26 22:49 +03 incident) ------------------
# .seal/nexus-seal.v1.json is DESIGNED to ride the public snapshot chain: it is
# AES-256-GCM ciphertext (key = scrypt(owner passphrase)), statistically random
# base64url — which can accidentally match 'sk-[A-Za-z0-9_-]{20,}' / 'hf_…'
# substrings (fail-closed aborts at 21:49 + 22:31 while the file was exactly
# what it must be). The exemption is STRUCTURAL, never name-based: a .seal/
# file is exempt ONLY if it validates as the exact envelope schema — 6 known
# top-level keys, meta counts numeric, kdf/iv/tag/ct pure base64url, check pure
# hex. Any deviation → the file stays in the scan set (fail closed). jq missing
# → no exemption at all (fail closed).
SEAL_EXEMPT=""
SEAL_CANDIDATES=$(printf '%s\n' "$FILES" | grep -E '^\.seal/' || true)
if [[ -n "$SEAL_CANDIDATES" ]]; then
  if command -v jq >/dev/null 2>&1; then
    while IFS= read -r sf; do
      [[ -f "$sf" ]] || continue
      if jq -e '
        type == "object"
        and (keys == ["check","ct","iv","kdf","meta","tag"])
        and (.meta | type == "object" and .version == 1 and (.sealedAt | type == "string")
             and (.counts | type == "object" and (keys | length) == 5
                  and ([.[] | type] | all(. == "number"))))
        and (.kdf | type == "object" and (.n | type == "number") and (.r | type == "number") and (.p | type == "number")
             and (.salt | type == "string" and test("^[A-Za-z0-9_-]+$")))
        and (.check | type == "string" and test("^[a-f0-9]{64}$"))
        and (.iv  | type == "string" and test("^[A-Za-z0-9_-]+$"))
        and (.tag | type == "string" and test("^[A-Za-z0-9_-]+$"))
        and (.ct  | type == "string" and test("^[A-Za-z0-9_-]+$"))
      ' "$sf" >/dev/null 2>&1; then
        SEAL_EXEMPT="${SEAL_EXEMPT}${sf}"$'\n'
        FILES=$(printf '%s\n' "$FILES" | grep -vxF "$sf" || true)
        echo "seal-exempt: $sf (validated ciphertext envelope — schema-exact, no plaintext fields)"
      else
        echo "seal-suspect: $sf failed envelope validation — kept in the scan set (fail closed)"
      fi
    done <<< "$SEAL_CANDIDATES"
  else
    echo "seal-suspect: jq unavailable — .seal/ files kept in the scan set (fail closed)"
  fi
fi

declare -A PATTERNS=(
  [github-token]='gh[pousr]_[A-Za-z0-9]{20,}'
  [github-finegrained]='github_pat_[A-Za-z0-9_]{20,}'
  [supabase-pat]='sbp_[A-Za-z0-9]{20,}'
  [supabase-secret]='sb_secret_[A-Za-z0-9]{20,}'
  [supabase-publishable]='sb_publishable_[A-Za-z0-9]{20,}'
  [jwt]='eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'
  [openai-style-key]='sk-[A-Za-z0-9_-]{20,}'
  [google-key]='AIza[0-9A-Za-z_-]{30,}'
  [slack-token]='xox[abprs]-[A-Za-z0-9-]{10,}'
  [huggingface]='hf_[A-Za-z0-9]{20,}'
  [private-key-block]='-----BEGIN [A-Z ]*PRIVATE KEY-----'
  [basic-url-creds]='[A-Za-z0-9_]{2,}:[^[:space:]@/]{8,}@[A-Za-z0-9]'
  # R11: only flag LITERAL secret assignments (RHS = plain token at end of line).
  # Code that READS the var ($(…), "$NEW", printf '%s') must not trip the scanner.
  [env-secret-assignment]='(PANEL_PASSWORD|SESSION_SECRET|ENCRYPTION_KEY|QSTASH_TOKEN|UPSTASH_[A-Z_]*TOKEN|VYCE_API_KEY|GROQ_API_KEY)=[A-Za-z0-9_/@+=.-]{6,}[[:space:]]*$'
)

EXIT=0
for name in "${!PATTERNS[@]}"; do
  # shellcheck disable=SC2086
  HITS=$(printf '%s\n' "$FILES" | xargs grep -nE -i "${PATTERNS[$name]}" 2>/dev/null \
    | grep -vE 'localhost|proxy-host|example\.com|postgresql://[^:]+:\*' || true)
  if [[ -n "$HITS" ]]; then
    EXIT=1
    while IFS= read -r line; do
      FILE=$(echo "$line" | cut -d: -f1)
      LINENO_=$(echo "$line" | cut -d: -f2)
      PREFIX=$(echo "$line" | cut -d: -f3- | grep -oE "${PATTERNS[$name]}" | head -1 | cut -c1-8)
      echo "SECRET-HIT [$name] $FILE:$LINENO_ masked=${PREFIX}***"
    done <<< "$HITS"
  fi
done

if [[ $EXIT -eq 0 ]]; then
  echo "SCAN OK: no secret-shaped hits in $(echo "$FILES" | grep -c .) files ($(TZ=Europe/Istanbul date '+%Y-%m-%d %H:%M %Z'))"
fi
exit $EXIT
