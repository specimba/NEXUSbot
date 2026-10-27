# docs/tasks.md — dependency-ordered task cards

> Card format per directive Appendix A. One writer per file-set (P5). Every task: implement → self-check → commit → journal. File scope is exhaustive — touching files outside scope = defect.

## Milestone M1 — walking skeleton (all: owner role Backend/Frontend Engineer; verify: independent Verifier)

**T-101 · Prisma schema v1 + WAL baseline**
Depends: G2+G4 signed · Files: prisma/schema.prisma, src/lib/db.ts · Contract: all §3 tables (Events, Outbox, Job, Artifact, ConsumerOffset, Setting, DeviceFlow, ConnectorRun + lease fields) · Acceptance: `db:push` clean; WAL + busy_timeout set (NFR-11) · Verify: `bun run db:push && prisma validate` · Rollback: drop tables (no data yet)
**T-101a · Spike (timebox 45 min, kill criterion in plan §4):** parallel API writes vs direct-writer probe; document result in worklog; no production code.

**T-102 · Event module + ingest API**
Depends: T-101 · Files: src/lib/events.ts, src/app/api/events/route.ts, src/lib/ratelimit.ts · Contract: FR-01/02 envelope validation, dedupe, 30/min IP limit, error shape §11 · Acceptance: FR-01 GWT ×2 + RT-11 race · Verify: targeted GWT via curl script · Rollback: revert route (schema additive)

**T-103 · Outbox + consumer loop**
Depends: T-102 · Files: src/lib/outbox.ts · Contract: FR-05, topics §3, offsets, at-least-once + idempotent consumers · Acceptance: FR-05 crash-between GWT · Verify: forced-crash test script · Rollback: disable consumer loop flag

**T-104 · Job runner (lease, checkpoint, recovery, budgets)**
Depends: T-103 · Files: src/lib/jobs.ts, src/app/api/jobs/route.ts · Contract: FR-03/07/27, checkpoint schema §3 · Acceptance: FR-03 GWT + kill-9 GWT (dispatch/ between-steps/ mid-artifact) + budget GWT · Verify: kill-restart script ×3 · Rollback: runner flag off (jobs stay queued)

**T-105 · Artifact store**
Depends: T-104 · Files: src/lib/artifacts.ts, src/app/api/artifacts/route.ts (+ /:id) · Contract: FR-04 paths + sha256 + integrity_error · Acceptance: FR-04 GWT + hash match · Verify: script · Rollback: revert

**T-106 · Dev ops endpoints (seed/backup/replay/retention)**
Depends: T-105 · Files: src/app/api/dev/{seed,backup,replay,retention}/route.ts · Contract: FR-08/28/30/31 · Acceptance: GWT each; replay hashes ×2 identical · Verify: script + timed restore drill · Rollback: revert

**T-107 · Panel auth**
Depends: T-101 · Files: src/lib/auth.ts, src/middleware.ts, src/app/api/auth/{login,logout}/route.ts · Contract: FR-29 (password env, signed cookie, throttle, authz matrix) · Acceptance: FR-29 GWT · Verify: curl 401/200 matrix · Rollback: revert (dev-only)

**T-108 · Panel shell + tab registry + Overview (live)**
Depends: T-102..106 · Files: src/app/page.tsx, src/app/layout.tsx, src/components/panel/* · Contract: FR-06/10, registry §3, sticky footer, skeletons/empty/error per §8 · Acceptance: tiles read live APIs; empty states honest; responsive · Verify: browser walkthrough + lint · Rollback: revert

**T-109 · Pipeline tab (events/jobs/artifacts/DLQ + re-drive)**
Depends: T-108 · Files: src/components/panel/pipeline/* · Contract: FR-02 views + FR-31 DLQ section + manual re-drive · Acceptance: DLQ visible after forced failure; re-drive works · Verify: browser + script · Rollback: revert

**T-110 · Userscript dual-target snippet + Stream tab (read-only live)**
Depends: T-108 · Files: docs/runbook.md (snippet), src/components/panel/stream/* · Contract: RT-05 M1 real-event requirement; viewer.sample + ai.exchange render · Acceptance: one REAL event from owner's channel path lands in L0 and renders · Verify: end-to-end walkthrough · Rollback: tab hides when no data (honest empty state)

**T-111 · M1 acceptance walkthrough**
Depends: T-102..110 · Files: docs/verify.md, docs/STATE.md, CHANGELOG.md · Contract: G5 checklist — all M1 GWT, NFR-01 load profile, NFR-02 drill timed, NFR-07 replay, gitleaks, preflight, lint, verifier sign-off · Verify: independent Verifier agent · Rollback: n/a (gate)

## Milestone M2 — operator surface & connectors (kickoff: GWT amendment per spec §5)

**T-201** Vault crypto (FR-11 contract) — lib/crypto.ts, api/credentials/*; tamper + rotation GWT · Rollback: revert
**T-202** GitHub device flow + snapshot push (FR-12) — lib/connectors/github.ts, api/github/*, Settings GitHub card · Rollback: card hides unconnected
**T-203** Supabase connector (FR-13, OQ4 dual-path) — lib/connectors/supabase.ts, api/connectors/supabase/*; drain idempotent · Rollback: connector flag
**T-204** Upstash connector (FR-14) · **T-205** Hyperbrowser connector (FR-15) · **T-206** Webshare connector (FR-16, routing OFF)
**T-207** Stream tab full (FR-17) + ingest token option (OQ2) · **T-208** Settings tab + budgets (FR-18, FR-32 gateway actor)
**T-209** M2 acceptance walkthrough (G5) — verify.md update

## Milestone M3 — evaluation harness (kickoff: owner signs eval set)
**T-301** docs/eval/ scaffold + versioning (FR-19) · **T-302** paired run engine + variance (FR-20) · **T-303** regression ceilings + contamination check (FR-21/22) · **T-304** Eval tab reports · **T-305** M3 acceptance

## Milestone M4 — improvement loop
**T-401** variant registry (FR-23) · **T-402** sandbox eval (FR-24) · **T-403** gated promotion + one-command revert + ADR (FR-25) · **T-404** kill-switch UX (FR-26) · **T-405** M4/G6 release: runbook, restore re-drill, tag v0.1
