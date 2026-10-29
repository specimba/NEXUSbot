# NEXUS OS — Deploy Kit (stable foundation)

Two paths, one goal: the panel + kick-bridge + cadence services run 24/7 on a stable
origin, with SQLite on persistent storage, and the GitHub snapshot chain + sandbox seal
as the disaster-recovery layer (they are host-independent — see docs/migration-runbook.md).

- **Path A (recommended): Oracle Always Free VM** → `sudo bash vm-setup.sh <your-duckdns-domain>`
- **Path B: Docker / docker-compose** (any VM, HF Space, etc.) → `docker compose -f deploy/docker-compose.yml up -d --build`

Both paths produce the same layout:

```
/opt/nexus            repo + build (.next/standalone)
/opt/nexus/data        persistent: custom.db, .env, logs   ← survives redeploys
systemd: nexus-panel.service (Next.js :3000)
         nexus-minis.service (kick-bridge :3010, backup-cadence :3011,
                              bench-cadence :3012, mem-watchdog :3013)
caddy :443 → :3000     auto-HTTPS with your DuckDNS domain (deploy/Caddyfile.vm)
```

## Path A — Oracle Always Free VM (Ubuntu 24.04 ARM)

```bash
# on the fresh VM, as root:
apt-get update && apt-get install -y git curl
git clone https://github.com/specimba/NEXUSbot.git /opt/nexus
cd /opt/nexus/deploy
sudo bash vm-setup.sh nexus-specimba.duckdns.org   # your free DuckDNS domain
```

The script: installs bun + Caddy, generates `/opt/nexus/data/.env` with fresh random
secrets, builds the panel, pushes the Prisma schema, installs + starts the systemd
units, wires Caddy auto-HTTPS.

Then, in the panel:
1. Settings → **Sandbox seal → Restore** — paste your passphrase; vault credentials,
   widgets, OBS tokens, settings and the durability env keys all come back
   (the seal rides this repo, `.seal/nexus-seal.v1.json`).
2. Widgets → set-base to `https://<your-domain>` — the OBS Browser Source URL
   becomes permanent. Refresh OBS once; after that it never changes again.
3. Connectors → re-connect GitHub once (OAuth callback URL must be updated to the
   new domain in the GitHub App settings), then `bash scripts/snapshot-backup.sh`
   continues the same fast-forward chain on github.com/specimba/NEXUSbot.
4. Optional: point UptimeRobot (free) at `https://<your-domain>/api/health`.

## Path B — Docker

```bash
git clone https://github.com/specimba/NEXUSbot.git && cd NEXUSbot
docker compose -f deploy/docker-compose.yml up -d --build
```

The compose file mounts `./deploy/data` (db + .env + logs) and builds the production
image (bun + Next.js standalone + all four mini-services via the entrypoint).

## Environment

`deploy/env.example` documents the required variables. `vm-setup.sh` and the Docker
entrypoint generate fresh random values on FIRST boot; the seal restore then
overwrites the durability-critical four (SESSION_SECRET / ENCRYPTION_KEY /
ENCRYPTION_KEYS_PREV / PANEL_PASSWORD) with the sealed originals.

## Notes

- `bun run build` runs INSIDE the VM/container only. Never inside the z.ai sandbox
  (platform rule) — this kit never runs there.
- The kick-bridge reconnects to Kick realtime automatically (subscription logic is
  in the service itself).
- DR is already external: GitHub snapshot chain (source) + seal (state) + Supabase
  mirror (history). A full host loss is a ~10-minute recovery on any new host.
