# NEXUS OS — STATE

_Last updated: 2026-10-22 (M2-R rebuild session)_

## Status line

- Dev server: **RUNNING** on :3000 (pid in `.zscripts/dev.pid`) [MEASURED]
- Core E2E: **18/18 PASS** (`tests/verify-core.sh`) [MEASURED]
- Lint: **CLEAN** [MEASURED]

## Honest incident log

- **2026-10-22**: sandbox cold-reset wiped the workspace to the initial scaffold. The
  previous session's reported M1+M2-wave-1 work (7 commits, theme, connectors T-201…208)
  did **not** survive; only `upload/` (owner source material) remained. Root cause
  [VERIFIED]: `/start.sh` restores from `/home/sync/repo.tar` and rewrites `.env` to
  `DATABASE_URL`-only; the prior session's work was never captured into the tar.
- Consequences: panel password never existed on disk (owner's report was correct);
  hydration fix was lost (Grammarly attrs vs `<body>` without `suppressHydrationWarning`).
- Fixes shipped this session: full core rebuild; `ensure-env` hooked into
  `.zscripts/dev.sh` (survives future resets via repo.tar); commit-early discipline.

## Done (this session, all [MEASURED])

- Prisma schema: Event / Credential / IngestToken / Setting
- Secrets vault: AES-256-GCM versioned envelope, `VaultIntegrityError`, rotation window
- Auth: PANEL_PASSWORD + HMAC session cookie, in-route `requireSession`, login rate limit
- L0 stream: `/api/events` GET+POST (session or bearer ingest token), 8 KiB clamp
- Ingest tokens: create-once / list / revoke (hashes only)
- Budgets: whitelisted KV via `/api/settings`
- Panel UI: login gate, shell (5 tabs), Overview, Stream (2s poll + token manager),
  Settings, Connectors (honest wave-2 placeholder), Eval (G6-locked placeholder)
- Theme: dark = fallout×matrix×cyberpunk (oklch tokens, phosphor grid, scanlines, glow
  utilities), light = neutral Apple-default; `suppressHydrationWarning` on html+body
- Env bootstrap: `scripts/ensure-env.sh` + `rotate-panel-password.sh`; boot-hooked

## In progress — Wave-2 (owner-approved)

| Task | Scope |
| --- | --- |
| T-202+T-203 | GitHub OAuth web-flow (never PAT) + Supabase Mgmt API connector |
| T-204 | Upstash REST connector (XADD/XREADGROUP, /pipeline) |
| T-205 | Hyperbrowser connector (REST, CDP) |
| T-206 | Webshare proxy pool (probe-first, routing default OFF) |

## Queue

- T-209: M2 acceptance sweep (all verify suites green + browser walkthrough)
- Owner-side: GitHub App registration → paste Client ID/Secret via panel; paste Supabase
  Mgmt PAT via panel; G5 real userscript events + `docs/verify.md` sign-off
- L1/L2 agent capabilities (MoE roster) after wave-2 lands

## Owner comms protocol (standing)

Every orchestrator report must contain: ① server/preview state [MEASURED], ② changes
with claim tags, ③ explicit "your actions now" list, ④ next queue. Honest zero is
preferred over optimistic claims. Secret values are never printed (P7) — point the owner
to `.env` instead.
