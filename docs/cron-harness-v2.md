# Cron Harness v2 — Improvement Duty-Wheel (2026-10-30)

Replaces the v1 "harness review" schedule. Owner verdict on v1: *"simple health check and
progression theatre."* Root cause of the theater: v1 had only ONE mode — hunt defects, else
heartbeat — and the system is healthy, so 17 consecutive runs ended in heartbeat notes while
real work (routing misfires, empty RSI eval tables, unshipped capability queue) piled up.

## Design principle

Every 4h cycle must end in one of exactly two states:
1. **SHIPPED** — a measured fix/upgrade/eval landed in src or in the RSI tables, gates green.
2. **PROVED-IDLE** — one-line heartbeat that carries the numbers that prove nothing was due.

"Checked, all green" with no evidence is theater. The health gate is retained for safety but
demoted from the whole job to step zero.

## Duty-wheel

Slot = `floor(Istanbul hour / 4) mod 4`, computed from the cycle's fire time. The health gate
runs in EVERY slot; a real defect hit overrides rotation (DEFECT runs now, wheel resumes next
cycle — a bad hour never gets lost).

| Slot | Name | Work |
|---|---|---|
| 0 | DEFECT | Root-cause pass over logs + readonly sqlite probes of `db/custom.db` (probe patterns: `scripts/cron-20261030-0825-*.ts`). Fix TOP issue only, properly in src. Clean → fall through to RSI-EVAL work. |
| 1 | RSI-EVAL | Sample last ~200 `InteractionLog` rows: route accuracy (research misfires, lore hits, relevance drops, EXA off-topic posted answers), p50/p95 latency per route, emoji/dupes. Pick ONE recurring failure class → smallest real fix (pattern/guard) or a measured eval against a seeded `RsiSuite` (6 suites / 31 tasks exist; record `RsiRun` + `RsiImprovementEdge`). |
| 2 | UPGRADE | Top unshipped slice from `docs/capability-upgrade-plan.md` §5 queue, `docs/hyperbrowser-integration.md` phases, `docs/agentmail-deep-dive.md` parked queue, or latest worklog RSI Ledger. ONE additive slice ≤150 lines, probe-gated. Owner-gated items → fall through to RSI-EVAL. |
| 3 | DURABILITY | `.zscripts/backup-state.json` lastOk >20h → `NEXUS_BACKUP_FORCE=1` push, verify scan+PUSH+TAG; seal freshness vs DB row counts (report drift, NEVER auto-seal); mini-services health (:3010/:3012/:3013); watchdog restarts + memory trend since last cycle. |

With fires every 4h (6/day), weekly coverage ≈ DEFECT ×3.5, RSI-EVAL ×3.5, UPGRADE ×1.75,
DURABILITY ×1.75 — defects and evals get double weight by design; durability runs often enough
to catch the 20h backup-gap rule.

## Why RSI-EVAL is a first-class slot

The RSI tables (`RsiSuite`, `RsiTask`, `RsiCycle`, `RsiRun`, `RsiImprovementEdge`) were seeded
but `RsiRun`/`RsiCycle` are empty — the eval loop has never been exercised. Slot 1 closes that:
it turns the live traffic stream into (a) routing-upgrade fixes with before/after evidence and
(b) recorded eval runs, which is what "RSI controlling" means operationally.

## Ledger discipline

Every worklog entry ends with an **RSI Ledger**: recurring failure classes named as
routing-upgrade candidates. Slot 2 and slot 1 read the ledger as their input queue — the
worklog becomes the shared memory between cycles, not a diary.

## Constraints (unchanged from v1, non-negotiable)

Next.js 16 App Router, port 3000 only, api routes not server actions, z-ai-web-dev-sdk
backend-only, never `bun run build`, never edit `.env`, never touch Credential/vault/owner DB
rows (readonly queries fine), never message the live Kick chat, never stop the dev server
without an immediate verified respawn, lore is owner-authored (propose-only), no OAuth
re-auth — log symptom, stop thread. Gates after src change: `bun x tsc --noEmit` (zero NEW
errors), `bun run lint` clean, agent-browser golden path (login = `PANEL_PASSWORD` in `.env`;
Connectors renders + `/api/kick/status` 200).

## Sizing & KPI

- Prompt payload: 3,392 chars (< 4,000 budget). Lives verbatim at `.zscripts/cron-prompt-v2.txt`.
- KPI, tracked in heartbeat entries: **ship rate** = cycles ending SHIPPED / total. Healthy
  target ≈ 50–70% once the queues drain; sustained < 30% means the queues are stale and the
  schedule must be re-designed again.
