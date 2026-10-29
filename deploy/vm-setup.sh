#!/usr/bin/env bash
# NEXUS OS — one-shot VM bootstrap (Path A, docs/migration-runbook.md).
# Target: fresh Ubuntu 22.04/24.04 (x64 or ARM — Ampere A1 free tier fits).
# Idempotent: safe to re-run.
#
#   sudo bash deploy/vm-setup.sh <your-duckdns-domain>
#
# What it does:
#   1. installs bun + Caddy
#   2. /opt/nexus/data/.env — generated ONCE with fresh random secrets
#   3. bun install + prisma generate + db push + next build (standalone)
#   4. installs + starts systemd units: nexus-panel + 4 mini-services
#   5. Caddy auto-HTTPS on :443 → :3000 for <your-duckdns-domain>
set -euo pipefail

DOMAIN="${1:-}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$REPO_DIR/data"

[[ -n "$DOMAIN" ]] || { echo "usage: sudo bash deploy/vm-setup.sh <your-duckdns-domain>"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }

echo "== NEXUS OS vm-setup: domain=$DOMAIN repo=$REPO_DIR =="

# --- 1) bun -------------------------------------------------------------------
if ! command -v bun >/dev/null; then
  echo "[1/5] installing bun"
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi
BUN="$(command -v bun)"
echo "[1/5] bun: $BUN"

# --- 2) data dir + .env (ONCE) ------------------------------------------------
mkdir -p "$DATA_DIR"
ENV_FILE="$DATA_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[2/5] generating $ENV_FILE with fresh random secrets"
  {
    echo "DATABASE_URL=file:$DATA_DIR/custom.db"
    echo "PANEL_PASSWORD=$(openssl rand -base64 48 | tr -d '\n')"
    echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "ENCRYPTION_KEY=$(openssl rand -base64 48 | tr -d '\n')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "[2/5] $ENV_FILE exists — keeping it"
fi
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
export DATABASE_URL="file:$DATA_DIR/custom.db"

# --- 3) deps + schema + build --------------------------------------------------
echo "[3/5] bun install + prisma + next build (a few minutes)"
cd "$REPO_DIR"
"$BUN" install --frozen-lockfile
"$BUN"x prisma generate
"$BUN"x prisma db push --accept-data-loss
(cd mini-services/kick-bridge && "$BUN" install --frozen-lockfile)
"$BUN" run build

# --- 4) systemd units ----------------------------------------------------------
echo "[4/5] installing systemd units"
for unit in nexus-panel nexus-kick-bridge nexus-backup-cadence nexus-bench-cadence nexus-mem-watchdog; do
  sed "s#__REPO__#$REPO_DIR#g; s#__DATA__#$DATA_DIR#g" \
    "$REPO_DIR/deploy/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable --now nexus-panel nexus-kick-bridge nexus-backup-cadence nexus-bench-cadence nexus-mem-watchdog

# --- 5) Caddy auto-HTTPS ---------------------------------------------------------
echo "[5/5] Caddy → https://$DOMAIN"
if ! command -v caddy >/dev/null; then
  apt-get update -qq && apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi
sed "s#__DOMAIN__#$DOMAIN#g" "$REPO_DIR/deploy/Caddyfile.vm" > /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl restart caddy

cat <<DONE

== DONE ==============================================================
Panel:     https://$DOMAIN          (Caddy :443 → :3000, auto-TLS)
Health:    https://$DOMAIN/api/health

Next (in the panel):
  1. Settings → Sandbox seal → Restore — paste your passphrase.
     Vault credentials, widgets, OBS tokens, settings + the durability
     env keys all come back in one click.
  2. Widgets → set-base → https://$DOMAIN  → the OBS URL is now PERMANENT.
  3. Connectors → re-connect GitHub (update the App callback URL to the
     new domain first), then:  bash scripts/snapshot-backup.sh
  4. Optional: UptimeRobot free pinger → https://$DOMAIN/api/health

Logs:     journalctl -u nexus-panel -u nexus-kick-bridge -f
Sealed state rides the repo: .seal/nexus-seal.v1.json (passphrase-encrypted).
======================================================================
DONE
