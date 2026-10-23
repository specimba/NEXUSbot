#!/usr/bin/env bash
# NEXUS OS — fail-closed secret scanner (runs before any public push).
# Scans the sanitized snapshot file set. Exit 1 on ANY hit.
# P7: on a hit, print file:line + pattern name + masked prefix ONLY — never full values.
set -uo pipefail
cd "$(dirname "$0")/.."

# Build the same sanitized file set the snapshot uses.
# R11 hardening: also deny db/vault/artifact dirs and binary/db artifacts outright.
FILES=$(git ls-files \
  | grep -vE '^(upload|download|db|ops/vault|tool-results|agent-ctx|directives|tests|\.next)/' \
  | grep -vE '\.(png|db|sqlite|tar|log|tsbuildinfo)$')
# Double-guard: refuse to run if any forbidden path is still INDEXED (tracked).
# R14: extended after the platform sync process gutted .gitignore and re-tracked
# .env/.next/db/upload — the guard is what fail-closed the whole chain that day.
if git ls-files | grep -qE '^(\.env|\.next/|db/|ops/vault/|upload/|tool-results/|agent-ctx/)|\.db$|\.tsbuildinfo$'; then
  echo "SECRET-HIT [index-guard] forbidden path still tracked: run scripts/hygiene-untrack.sh"
  exit 1
fi
if [[ -z "$FILES" ]]; then echo "SCAN: no files"; exit 0; fi

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
  echo "SCAN OK: no secret-shaped hits in $(echo "$FILES" | wc -l) files ($(TZ=Europe/Istanbul date '+%Y-%m-%d %H:%M %Z'))"
fi
exit $EXIT
