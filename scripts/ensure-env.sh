#!/usr/bin/env bash
# NEXUS OS — idempotent .env bootstrap.
# P7 rule: prints key NAMES only. Secret values are generated in-place, never echoed.
set -euo pipefail
cd "$(dirname "$0")/.."

touch .env

add() {
  local k="$1" v="$2"
  if ! cut -d= -f1 .env | grep -qx "$k"; then
    printf '%s=%s\n' "$k" "$v" >> .env
    echo "added  $k"
  else
    echo "ok     $k (already present, value untouched)"
  fi
}

# Database (SQLite, Prisma)
add DATABASE_URL "file:/home/z/my-project/db/custom.db"

# Session signing secret (HMAC, 32 bytes hex)
add SESSION_SECRET "$(openssl rand -hex 32)"

# Panel login password (128-bit hex). Owner reads it from .env — see docs/runbook.md §0.
add PANEL_PASSWORD "$(openssl rand -hex 16)"

# Vault encryption key (AES-256-GCM, 32 bytes hex) — see src/lib/crypto.ts
add ENCRYPTION_KEY "$(openssl rand -hex 32)"

echo "---"
echo "keys present: $(cut -d= -f1 .env | tr '\n' ' ')"
echo "done. Never commit .env (gitignored). Rotation: scripts/rotate-panel-password.sh"
