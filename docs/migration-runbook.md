# NEXUS OS — Migration Runbook: from the sandbox to a stable foundation

_Research pass 1: 2026-10-29, 20:15 +03 — free-tier landscape, Oracle-first.
Research pass 2: 2026-10-29, 20:50–21:10 +03 — CARDLESS deep-dive (the owner's Oracle signup FAILED
at card verification, so the entire field was re-probed for "no card, ever": HF Spaces, Koyeb, Render,
Zeabur, Serv00, ClawCloud, UptimeRobot). Evidence tags per AGENTS.md §4: [MEASURED] = live-probed from
the sandbox tonight; [INFERRED] = strong prior knowledge, not re-verified tonight; [UNVERIFIED] = hearsay._

---

## 0. TL;DR

| Rank | Foundation | Cost | Always-on | Persistent disk | Card needed | Verdict |
|---|---|---|---|---|---|---|
| **A** | **Hardened sandbox (proven 3×: live p50 6.0 s / p95 14.5 s hours after today's wipe)** | €0 | ❌ daily reset window ~16:25–16:40Z, recovery ~2–5 min | ❌ per-boot — seal + mirror restore | no | **The workhorse: ~10× the resources of any cardless tier. Keep streaming on it.** |
| **B** | **Render free Docker service + UptimeRobot pinger** — permanent URL, cardless | €0 | ⚠️ sleeps after 15 min idle → 5-min pinger keeps it warm; 750 h/mo covers a 24/7 service | ❌ ephemeral — seal + mirror-backfill restore (proven in prod today) | **no [MEASURED]** | **The cardless permanent-URL second host — "a bit lower resourced" (512 MB, shared CPU), exactly the owner's stated tolerance** |
| C | Zeabur Free / Serv00 (FreeBSD) | €0 | ⚠️ auto-sleep / process limits | mixed | no | Same ~512 MB class — fallbacks behind Render |
| D | Oracle A1 / HF Docker / Koyeb / Fly / Cloud Run / Railway | — | — | — | **yes — owner card-blocked or platform paywalled** | Rejected — see §3, §5 |

**Recommendation (pass 2): DUAL-HOST.** Oracle died at the owner's card verification and HF's free
Docker Space died with its 2026 paywall — so the play is: (1) keep the sandbox as the live-stream
workhorse (biggest free resources anywhere; today's third wipe recovered in ~20 min and served
p50 6 s traffic all evening); (2) stand up the SAME image on Render free — a PERMANENT https URL
for OBS, the panel bookmark and OAuth callbacks, kept warm by UptimeRobot; (3) let the seal +
auto-reseal + Supabase mirror keep both hosts rebuildable from each other in minutes (§6). When the
owner is satisfied the Render host is solid, Widgets set-base moves there once and the OBS URL
freezes forever.

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

## 3. Option A — Oracle Cloud Always Free VM — ❌ BLOCKED 2026-10-29 (owner card verification fails; kept for reference if a usable card ever appears)

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

## 4. Option B — the CARDLESS class (owner is card-blocked; re-probed 20:50–21:10 +03)

The owner's constraint, verbatim: *"I have tried oracle free before it not registering me due to card
issues for free we need to card integration. We need better or equal or a bit lower resourced
alternative."* → every candidate below was re-measured for "no card, ever".

**What died between pass 1 and pass 2 (both [MEASURED] 2026-10-29):**

- **HF Spaces (Docker)** — the 20:15 fallback is DEAD for free. huggingface.co/docs/hub/spaces-overview
  (live tonight): *"Gradio and Docker Spaces run on compute and require a paid plan to create: PRO for
  personal accounts… The default CPU Basic hardware has no hourly cost, but creating a Space that runs
  on compute (Gradio or Docker) requires a paid plan, while Static Spaces are free for everyone."* CPU
  Basic (2 vCPU / 16 GB / FREE) still exists — but you can no longer CREATE a Docker Space on it
  without PRO ($9/mo).
- **Koyeb** — koyeb.com/docs/faqs/pricing (live): *"We require a credit card to prevent fraud and
  abuse. We verify the card you enter by placing a $29 pre…"* → same wall as Oracle.
- **ClawCloud Run** — [UNVERIFIED, dropped]: run.claw.cloud returned 503 from the sandbox tonight and
  web search is polluted by the unrelated "OpenClaw AI-agent hosting" brand; the "$5/mo free credit,
  GitHub account ≥180 days" claim could NOT be re-verified. Do not build on it.

**The survivors — and their honest ceiling (all [MEASURED] tonight):**

| Host | Card | Resources | Sleep / wake | Runs the deploy/ kit? | Notes |
|---|---|---|---|---|---|
| **Render free web service** | **no** (docs: "No credit card is required") | 512 MB RAM, 0.1 CPU, 750 instance-h/mo | spins down after 15 min idle; 5-min UptimeRobot ping keeps it warm; ~1 min cold start when it slips through | ✅ Docker deploy (`deploy/Dockerfile` + root `render.yaml`, shipped tonight) | Persistent disk is a paid feature → state rides seal + Supabase mirror (the restore path proven in prod today); env-injected secrets preserved by the entrypoint fix |
| Zeabur Free Plan | no (docs: "No credit card required — just sign up") | ~512 MB class | "Services on the Free Plan automatically sleep after a period of inactivity… wake up on the next incoming request" (docs, live) | ✅ Dockerfile deploy | Dev plan $5/mo beyond free |
| Serv00 (FreeBSD) | no (offer page live: "completely free hosting… no ads or fees") | **512 MB RAM**, 15 system processes, 3 GB SSD, unlimited transfer, Node.js + SSH + crontab | always-on via SSH processes + crontab keepalive (no bun on FreeBSD → run panel standalone under node) | ⚠️ needs the node variant | 170k+ accounts, forum-only support, process limits actively enforced |

**The uncomfortable truth [MEASURED]: every free, cardless, 24/7-capable option lands at ~512 MB RAM.**
The sandbox gives this project ~10× that. The trade is resources vs permanence — hence DUAL-HOST (§0).

**Why 512 MB is still viable for NEXUS (honest engineering):** the ~2 GB RSS seen in the sandbox is
`next dev` mode. The deploy/ kit builds the **standalone production server** (typically 200–400 MB
for this app) + kick-bridge (~50 MB) + backup-cadence + mem-watchdog; bench-cadence is optional there.
p50 latency is dominated by upstream LLM waits, not local CPU share. The OBS widget is one HTML page
plus one stream route. It fits — tightly, with the watchdog guarding. If the free-tier Docker build
OOMs, build the image locally and deploy from a registry instead.

**Neon swap no longer required (pass-2 simplification):** with the auto-reseal + state-carrying
workspace exports + mirror backfill all proven in production TODAY, the SQLite + seal story already
survives ephemeral disks — a restart costs at most the mirror-push window. Neon free Postgres remains
an optional hardening later, not a migration blocker.

---

## 5. Rejected / limited (the "wider search", honestly)

| Platform | Finding | Why rejected for NEXUS |
|---|---|---|
| Fly.io | pricing live — free allowances now tied to legacy/plans [MEASURED]; new orgs pay-as-you-go | Not free-certain; needs card; ~$2–5/mo realistic |
| Render free | PROMOTED to rank B in pass 2 — cardless [MEASURED], 512 MB, 15-min idle sleep, ephemeral disk | Survivable: production standalone (~300 MB) + seal/mirror restore + 5-min pinger; 750 h/mo fits one 24/7 service |
| Koyeb free | docs FAQ live [MEASURED pass 2]: "We require a credit card… $29 pre-auth" | Card pre-auth — the same wall that blocked Oracle |
| HF Spaces (Docker) | docs live [MEASURED pass 2]: "Gradio and Docker Spaces… require a paid plan to create: PRO" | The 20:15 fallback is DEAD for free — CPU Basic exists but Docker Space creation is paywalled |
| ClawCloud Run | run.claw.cloud 503 from the sandbox; search polluted by the unrelated "OpenClaw" brand [UNVERIFIED] | The "$5/mo, GitHub ≥180d" claim could not be re-verified tonight — do not build on it |
| Google Cloud Run | "2 million requests free per month" [MEASURED] | scale-to-zero + 60-min WebSocket cap + ephemeral disk — wrong shape for a 24/7 chat WS bot |
| Railway / Heroku / Replit / Glitch | [INFERRED] no longer free / dead | — |
| GitHub Codespaces | 120 core-h/mo [INFERRED] | not 24/7, recycles workspace |
| Cloudflare Workers + Durable Objects | generous free [INFERRED] | rewrite of panel + minis into Workers runtime — a port, not a migration |

---

## 6. Post-migration checklist (applies to any host — the seal/mirror/snapshot chain is host-agnostic)

- [ ] Panel: unseal from the seal carried in the repo — vault/OBS links/tokens return in one click.
- [ ] Widgets → set-base to the new origin; refresh the OBS source once — then never again.
- [ ] GitHub App + Kick app callback URLs → new domain.
- [ ] `scripts/snapshot-backup.sh` once from the new host — verify fast-forward against the same remote chain.
- [ ] Keep the UptimeRobot pinger on `/api/health` (free).
- [ ] Optional: keep the sandbox as a dev console — the seal/snapshot/mirror stack means either host can
      rebuild the other in minutes.

---

## 7. Decision — ANSWERED 2026-10-29 21:10 +03 (owner: card impossible; performance audited first, per their "wait, check this")

- **Performance verdict [MEASURED]**: healthy — 204 interactions in the DB (203 ok, 1 `direct`),
  p50 6019 ms / p95 14543 ms (matches the panel card 6056/14603); Exa research 1.6–1.9 s; honest
  abstention + live self-correction observed in the Turkish chat; all 3 flagged security attempts
  contained; kick-bridge + webhooks + L0 mirror all green. NO platform defect. The "strangely good"
  performance is real: today's rebuild + v36.9 hedged lanes + the Exa research tier are simply working
  under live load.
- **⚠️ The pending seal RESTORE was STOPPED for good reason [MEASURED]**: the seal on disk is still
  the 19:15:14 pre-wipe one (3 tokens — it predates the ~20:15 OBS-token reconstruction). Restoring it
  would revert the widget to the STALE token and re-break the OBS URL. The live DB is now NEWER than
  the seal — the correct one-click action is **RE-SEAL**, not restore.
- **1 owner click tonight: RE-SEAL** — Settings → Sandbox seal → passphrase → seal. With the seal-route
  fix shipped tonight (createSeal now primes the auto-reseal cache), a re-seal keeps the seal tracking
  every future vault/token/widget/settings mutation (≤45 s debounce) — the stale-seal class that nearly
  cost the OBS token today is closed.
- **This week (zero card, ~30 min): stand up Render free from the GitHub chain** — render.com →
  New + → Blueprint → pick `specimba/NEXUSbot` (root `render.yaml`, shipped tonight) → free plan →
  set PANEL_PASSWORD to anything (the sealed original hot-applies after seal-restore) → UptimeRobot
  HTTP monitor on `/api/health` every 5 min → panel → Restore seal → `scripts/backfill-from-mirror.ts`.
  That service URL is PERMANENT — point OBS/Widgets set-base there when satisfied.
- **Then decide by experience**: run dual-host for a week; then keep both (sandbox = stream workhorse,
  Render = permanent URL) or cut over fully. Either way the seal + mirror + snapshot chain rebuilds
  any host from any other in minutes.
