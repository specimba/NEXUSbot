# NEXUS OS — Migration Runbook: from the sandbox to a stable foundation

_Research pass: 2026-10-29, 20:15 +03. Evidence tags per AGENTS.md §4: [MEASURED] = live-probed from
the sandbox tonight; [INFERRED] = strong prior knowledge, not re-verified tonight; [UNVERIFIED] = hearsay._

---

## 0. TL;DR

| Rank | Foundation | Cost | Always-on | Persistent disk | Card needed | Verdict |
|---|---|---|---|---|---|---|
| **A** | **Oracle Cloud Always Free VM (Ampere A1)** | **€0 forever** | ✅ 24/7 | ✅ 200 GB | yes (not charged) | **The endgame — run everything on one real VM** |
| **B** | **Hugging Face Space (Docker) + Neon free Postgres + UptimeRobot pinger** | **€0** | ⚠️ needs keep-alive pinger | ❌ ephemeral → DB external | no | **Best zero-card fallback; brain survives restarts via seal** |
| **C** | **Stay in sandbox, hardened (shipped tonight)** | €0 | ❌ platform resets | ❌ per-boot | no | **Recovery now takes ~2 min, not 40 — but the URL still rotates** |
| D | Fly.io / Render free / Koyeb / Cloud Run free / Railway | €0–€3 | mixed | mixed | mixed | Rejected — see §5 |

**Recommendation: A.** One always-on ARM VM runs the panel, the kick-bridge, the cadence services and
SQLite on a persistent disk, behind a stable HTTPS domain (free DuckDNS + Caddy auto-TLS). The OBS
Browser Source becomes a FROZEN, permanent URL (Widgets → set-base to the VM origin). OAuth callbacks
get a stable domain. The sandbox stops being load-bearing — at worst it becomes a thin dev console.

---

## 1. What the 2026-10-29 incident actually proved (all [MEASURED])

The 19:20 +03 sandbox wipe destroyed **only four things** — everything else already lived outside it:

| Asset | Where it lives | Survived the wipe? |
|---|---|---|
| Brain (chat AI, exa research, guards) | **Supabase Edge Function `nexus-cortex` v36.9** — deployed on Supabase, egress from there | ✅ untouched |
| Interaction history | **Supabase Postgres mirror** (append-only, HMAC-signed) | ✅ 165 rows backfilled in one script run |
| Source code + docs | **GitHub `specimba/NEXUSbot` snapshot chain** (PUSH OK 20:02, tag `snapshot-20261029-2002`) | ✅ |
| Vault state (credentials, widgets, settings, tokens, `.env` keys) | **Seal** (`.seal/nexus-seal.v1.json`, passphrase-encrypted, rides the GitHub chain) | ✅ sealed 19:15:14 — restored by owner 19:47 |
| Upstash / QStash / external connectors | Upstash cloud | ✅ |
| OBS bridge URL (rotation-proof) | **GitHub Pages** `specimba.github.io/NEXUSbot/obs.html` + `obs-target.json` | ✅ |
| **SQLite `db/custom.db`** | sandbox disk | ❌ wiped → seal + mirror restored it |
| **`.env` keys (SESSION_SECRET / ENCRYPTION_KEY / PANEL_PASSWORD)** | sandbox disk | ❌ wiped → seal restored them |
| **`ops/vault/github.token`** (snapshot push credential) | sandbox disk | ❌ wiped → re-mirrored from vault tonight |
| **Panel origin URL + mini-services (kick-bridge WS)** | sandbox process | ❌ re-spawned per boot; URL rotates |

**The sandbox is already just a "head" — the brain, memory, history and durability live in the cloud.**
The only remaining sandbox-dependency is a 24/7 PROCESS (panel + kick-bridge) and a stable public URL.
That is exactly what a free VM gives you.

---

## 2. Why the Google Drive zips could not have prevented it ([MEASURED])

Audited tonight from the shared Drive folder (1QHsFi7Y…): `NEXUS-OS-source-2026-10-25/26/27/28/29.zip`
are the panel's own "Download workspace" exports — **source-only by design** ("NEVER .env, NEVER the db,
NEVER vault files" — `src/app/api/backup/workspace/route.ts`). 0 state-file entries in any of the three
newest zips. They carry code + RECOVERY.txt (panel password) — not runtime state.

**Fixed tonight so the Drive discipline becomes state-carrying:** the workspace export now includes
`.seal/nexus-seal.v1.json` (passphrase-encrypted state bundle — public by design, it already rides the
GitHub chain). Future Drive uploads of `NEXUS-OS-source-*.zip` restore EVERYTHING: drop the zip's
`.seal/` into a fresh workspace → panel → Settings → Sandbox seal → Restore.

**The durability stack as of tonight ([MEASURED]):**
1. Seal auto-refreshes ≤45 s after any vault/token/widget/settings mutation (auto-reseal, new).
2. GitHub snapshot chain pushes every 6 h + on-demand, fast-forward-only, per-run tags.
3. Supabase mirror owns history; `backfill-from-mirror.ts` restores it in one run.
4. Panel "Download workspace" zip now carries the seal for the Drive archive.

---

## 3. Option A — Oracle Cloud Always Free VM (recommended)

**Evidence [MEASURED 2026-10-29]:** oracle.com/cloud/free live: *"Always Free Cloud Services that can
be used for an unlimited time"* — Ampere A1 Compute, 24 GB total RAM, per-tenant no-expiry allowance.

**What you get:** a real Ubuntu VM, ~4 ARM cores / 24 GB RAM, 200 GB boot volume, 24/7, root access,
static public IP, no egress WAF (Groq un-blockable, direct Kick WS, direct Supabase Mgmt). Free DNS via
DuckDNS (live [MEASURED]) + Caddy auto-HTTPS.

**What runs there (the `deploy/` kit in this repo):**
- `nexus-panel.service` — Next.js standalone production server (`bun .next/standalone/server.js`, :3000)
- `nexus-minis.service` — kick-bridge (:3010), backup-cadence (:3011), bench-cadence, mem-watchdog
- Caddy on :443 → :3000 (auto-TLS with your DuckDNS domain)
- SQLite on the persistent volume — `db/custom.db` never leaves the disk; seal + snapshot chain keep the
  GitHub/Drive copies warm as DR.

**Owner setup steps (≈1–2 h, once):**
1. Create the Oracle free account (card required for verification, not charged on Always Free).
2. Launch an Ubuntu 24.04 ARM instance (Ampere A1, 4 OCPU / 24 GB / 200 GB), open ports 22/80/443.
3. Reserve a free DuckDNS subdomain (e.g. `nexus-specimba.duckdns.org`) with its token.
4. `git clone https://github.com/specimba/NEXUSbot.git && cd NEXUSbot/deploy && sudo bash vm-setup.sh`
   — installs bun, builds the panel, pushes the Prisma schema, installs the systemd units + Caddy.
5. Panel → Settings → Sandbox seal → **Restore** (the passphrase brings vault + widgets + tokens back).
6. Widgets → set-base `https://nexus-specimba.duckdns.org` → the OBS URL becomes PERMANENT.
7. Update OAuth callback URLs (GitHub App, Kick app) to the new domain; re-connect once.
8. `bash scripts/snapshot-backup.sh` — the GitHub chain continues from the same remote, no history break.

**Honest limits:** signup capacity can be scarce in popular regions (retry or pick another home region);
ARM-only CPU (all our deps are fine on ARM); Oracle can reclaim idle Always Free instances [INFERRED] —
the UptimeRobot free pinger (50 monitors [MEASURED]) covers that too.

---

## 4. Option B — zero-card fallback: HF Space + Neon + pinger

**Evidence [MEASURED]:** huggingface.co live — Spaces sleep after a period unused; neon.com live —
*"Free plan is permanent (not a trial); no credit card required"*, autosuspend after 5 min; Cloud Run —
*"2 million requests free per month"*; UptimeRobot — free plan live.

**Shape:** free HF Docker Space (2 vCPU / 16 GB [INFERRED]) runs the panel + minis; UptimeRobot pings
`/api/health` every 5 min so the Space never sleeps; SQLite replaced by Neon free Postgres (Prisma
provider swap, ~1 h work, no data model changes); seal + snapshot chain unchanged. Restart of the Space
= ~2 min cold start, history safe in Neon + mirror, vault safe in the seal.

**Why not first choice:** sleep risk if the pinger fails, ephemeral disk (upload/ must be re-seeded),
shared CPU, no fixed IP for potential Kick webhook hardening, and the Prisma provider swap is code churn
the VM path does not need.

---

## 5. Rejected / limited (the "wider search", honestly)

| Platform | Finding | Why rejected for NEXUS |
|---|---|---|
| Fly.io | pricing live — free allowances now tied to legacy/plans [MEASURED]; new orgs pay-as-you-go | Not free-certain; needs card; ~$2–5/mo realistic |
| Render free | free tier live, spins down on idle [MEASURED] | 512 MB too tight for panel + 4 mini-services + Prisma; persistent disk is paid; WS drops on spin-down |
| Koyeb free | free tier live [MEASURED] | 512 MB instance; ephemeral storage; same shape problems as Render |
| Google Cloud Run | "2 million requests free per month" [MEASURED] | scale-to-zero + 60-min WebSocket cap + ephemeral disk — wrong shape for a 24/7 chat WS bot |
| Railway / Heroku / Replit / Glitch | [INFERRED] no longer free / dead | — |
| GitHub Codespaces | 120 core-h/mo [INFERRED] | not 24/7, recycles workspace |
| Cloudflare Workers + Durable Objects | generous free [INFERRED] | rewrite of panel + minis into Workers runtime — a port, not a migration |

---

## 6. Post-migration checklist (applies to A and B)

- [ ] Panel: unseal from the seal carried in the repo — vault/OBS links/tokens return in one click.
- [ ] Widgets → set-base to the new origin; refresh the OBS source once — then never again.
- [ ] GitHub App + Kick app callback URLs → new domain.
- [ ] `scripts/snapshot-backup.sh` once from the new host — verify fast-forward against the same remote chain.
- [ ] Keep the UptimeRobot pinger on `/api/health` (free).
- [ ] Optional: keep the sandbox as a dev console — the seal/snapshot/mirror stack means either host can
      rebuild the other in minutes.

---

## 7. Decision requested from the owner

1. **Go Oracle VM (A)?** → you do the account + instance creation (needs your card), I already shipped
   `deploy/` and can drive the rest.
2. **No card possible?** → say the word and I do B (HF + Neon + pinger) — ~1 day of work incl. the Prisma
   provider swap and Space wiring.
3. **Stay in the sandbox for now?** → the hardened stack shipped tonight (auto-reseal + state-carrying
   Drive zips + mirror backfill) already made the next wipe a ~2-minute recovery — but the URL will keep
   rotating and the uptime will stay hostage to platform resets.
