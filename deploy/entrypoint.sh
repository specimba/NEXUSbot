#!/usr/bin/env bash
# NEXUS OS — container entrypoint: source /data/.env, then run the four
# mini-services in the background and the Next.js standalone server in the
# foreground (PID 1). Prisma schema is pushed at boot (idempotent).
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# 1) .env: mount one at /data/.env, else generate fresh random secrets ONCE.
ENV_FILE="$DATA_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[entrypoint] generating $ENV_FILE with fresh random secrets"
  {
    echo "DATABASE_URL=file:$DATA_DIR/custom.db"
    echo "PANEL_PASSWORD=$(openssl rand -base64 48 | tr -d '\n')"
    echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d '\n')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export DATABASE_URL="file:$DATA_DIR/custom.db"

# 2) Schema (idempotent; empty db on first boot).
cd /app
bunx prisma db push --accept-data-loss --skip-generate

# 3) Mini-services — background, log to files under the volume.
MINIS=(kick-bridge:3010 backup-cadence:3011 bench-cadence:3012 mem-watchdog:3013)
for entry in "${MINIS[@]}"; do
  name="${entry%%:*}"
  if [[ -f "mini-services/$name/index.ts" ]]; then
    echo "[entrypoint] starting mini-service $name"
    (cd "mini-services/$name" && exec bun index.ts) >> "$DATA_DIR/$name.log" 2>&1 &
  fi
done

# 4) Panel — foreground. Seal restore (panel -> Settings -> Sandbox seal)
#    will overwrite the durability env keys with the sealed originals at runtime.
echo "[entrypoint] starting NEXUS panel on :${PORT:-3000}"
exec env PORT="${PORT:-3000}" bun /app/.next/standalone/server.js
