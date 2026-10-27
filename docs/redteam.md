# docs/redteam.md — Phase 3 adversarial pre-mortem (spec draft v1)

**Date:** 2026-10-21 · **Reviewer:** independent Red-Team agent (fresh context, P6) · **Verdict:** FIX-THEN-FREEZE (8 blockers: RT-01..RT-09 minus RT-08) → all resolved below by spec amendment; **post-amendment status: no unresolved blocker (G3 exit)**.

## Findings & dispositions

| ID | Sev | Finding (condensed) | Disposition |
|---|---|---|---|
| RT-01 | critical | No lease/heartbeat/startup recovery for `running` jobs after kill -9; checkpoint schema and artifact commit ordering unspecified | **Mitigated** — spec: Job gains `leaseUntil`/`heartbeatAt`; frozen checkpoint schema §3; startup recovery sweep FR-27; new GWT for kill-during-dispatch / between-steps / mid-artifact-write |
| RT-02 | critical | Ingest rate limit has no number/keying; `/api/dev/seed` unauthenticated; no retention policy → anonymous flooding exhausts disk | **Mitigated** — FR-01 numeric limits (30 req/min/IP, burst 5/s, ≤32 KB, `Retry-After`); seed session-gated + cap 500 + server-side synthetic stamping; retention FR-31; 429/503 semantics |
| RT-03 | major | ADR-001 single-writer consequence never became a spec requirement; SQLITE_BUSY path untested | **Mitigated** — new NFR-11 (single writer; busy_timeout 5s; busy-path retry test) + writer-topology statement §12 |
| RT-04 | major | No M1 backup/restore FR; WAL copy tearing; ADR/NFR contradiction on drill timing | **Mitigated** — FR-28 backup via `VACUUM INTO` + artifact tarball + measured restore drill in M1; NFR-02 reconcile (drill at M1) |
| RT-05 | major | A10 binds real Kick capture to M1, but spec had it in M2 — skeleton would demo on synthetic data only (theatre risk) | **Mitigated** — M1 includes userscript **dual-target config** (v30 script gains a panel-ingest target; documented snippet, T-111); full contract formalization stays FR-17/M2. Real event required in M1 acceptance walkthrough |
| RT-06 | major | `job.lifecycle`/`system.log` payload schemas, Outbox topic enumeration, dispatch ownership unspecified → P4 violation | **Mitigated** — payload schemas + topic list + dispatch ownership frozen in §3 (only runner creates jobs; consumers enqueue via API only) |
| RT-07 | major | Panel auth only an open-question default; no authz matrix, no cookie/throttle rules | **Mitigated** — OQ1 resolved: **env password + signed HttpOnly SameSite=Lax cookie** binding as FR-29 with full endpoint authz matrix (§12) |
| RT-08 | major | Vault crypto unspecified (AEAD, nonce, tamper, rotation); GitHub refresh-rotation race has no failure path | **Mitigated** — crypto contract frozen in FR-11 (AES-256-GCM via WebCrypto, per-record 12-byte nonce, AAD=record id, keyId-prefixed ciphertext, rotation sweep, tamper GWT); refresh persists only after probe-call success (FR-12) |
| RT-09 | major | "Deterministic replay" unverifiable as written; NFR-01 has no load profile | **Mitigated** — replay defined as FR-30 (sandbox offset namespace, artifact-hash determinism GWT); NFR-01 pinned to 50 ev/min × 5 min profile |
| RT-10 | major | Nothing produces what L3/L4 measure: no model-gateway FR; budgets time-only (no token/cost) | **Accepted for M1 scope + scheduled** — FR-32 (M2): model-gateway actor with token/cost budget fields; M3 kickoff amendment owns eval wiring. Disposition recorded now (P2) |
| RT-11 | minor | Two error shapes conflict; idempotency-key race → 500 | **Mitigated** — single error shape §11 (`validation` code carries `details[]`); race rule: unique-violation retry → 200 `deduped:true` |
| RT-12 | minor | `synthetic` client-trusted; "DLQ view" has no FR; outbox `failed` terminal | **Mitigated** — server-side synthetic rule (source=seed ⇒ synthetic=true, enforced ingest-side); DLQ = Pipeline tab section (FR-31); manual re-drive button |
| RT-13 | minor | Payload fragments can reach logs (injection) | **Accepted** — single-operator, no downstream log consumers; structured JSON logging; residual risk documented in `docs/security.md` (M2 kickoff) |
| RT-14 | minor | Prisma/SQLite WAL+JSON concurrency assumptions not spike-proven | **Accepted with action** — timeboxed spike T-101a in plan.md (kill criterion: WAL+busy-timeout under parallel writes fails >2×/50 runs → revisit ADR-001 queue design) |
| RT-15 | minor | OQ defaults' binding status unstated | **Mitigated** — §10 note: unanswered OQs adopt their defaults at G2 |

**Blocker resolution:** RT-01/02/03/04/05/06/07/09 → spec amended (v1.1, this gate). RT-10 accepted-with-schedule. **G3 exit: no open critical/major.**
