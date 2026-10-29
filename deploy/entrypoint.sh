#!/usr/bin/env bash
# NEXUS OS — container entrypoint: source /data/.env, then run the four
# mini-services in the background and the Next.js standalone server in the
# foreground (PID 1). Prisma schema is pushed at boot (idempotent).
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# 1) .env: mount one at /data/.env, else generate it ONCE. Any value already
#    present in the environment (hoster-injected secrets — Render / Zeabur /
#    Spaces-style env UI) WINS over randoms, so secrets stay stable across
#    ephemeral reboots instead of rotating per boot.
ENV_FILE="$DATA_DIR/.env"
genpw() { openssl rand -base64 48 | tr -d '\n'; }
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[entrypoint] generating $ENV_FILE (pre-set hoster env wins over randoms)"
  {
    echo "DATABASE_URL=file:$DATA_DIR/custom.db"
    echo "PANEL_PASSWORD=${PANEL_PASSWORD:-$(genpw)}"
    echo "SESSION_SECRET=${SESSION_SECRET:-$(genpw)}"
    echo "ENCRYPTION_KEY=${ENCRYPTION_KEY:-$(genpw)}"
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
