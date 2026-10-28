# docs/verify.md — M1 acceptance record (T-111)

**Status:** verifier battery executed 2026-10-22 (second attempt; prior attempt's session-gated test-harness patches and screenshots 01–02 carried forward, not redone).
**Verifier:** independent (review-only for production code — findings recorded, no production edits).
**Build under test:** `main` head `e38f27d` (T-101..T-110 complete), M1 walking skeleton.
**Tag meanings:** [MEASURED] = number captured live this session · [VERIFIED] = script/walkthrough evidence this session · [UNVERIFIED] = not yet executable (owner-side step).

## 1. Suites (exit code · PASS)

| Suite | Result | Covers |
|---|---|---|
| verify-t102 | exit 0 · 7/7 | FR-01 dedupe/validation/rate-limit GWT (RT-02/11/12) |
| verify-t103 | exit 0 · 6/6 | FR-05 outbox/consumer, crash-between GWT, RT-13 audit lines |
| verify-t104 | exit 0 ×3 (runs 1–3) | FR-03 lifecycle/budgets, FR-07+FR-27 kill-9 recovery, lease sweep |
| verify-t105 | exit 0 · 11/11 | FR-04 artifact store, hash/integrity, FR-30 job-level determinism |
| verify-t106 | exit 0 · 13/13 | FR-08 seed, FR-28 backup, FR-30 replay idempotency, FR-31 retention, redrive |
| verify-t107 | exit 0 · 12/12 | FR-29 auth matrix, throttle lock, §11 authz split |
| verify-t108 | exit 0 · 5/5 | FR-10 shell/gate, gated metrics path (T-109 folded) |
| verify-t110 | exit 0 · 7/7 | FR-17 surface, Stream tab queries, RT-05 runbook |
| restore-drill (new) | exit 0 · 5/5 | FR-28/NFR-02 timed drill |
| load-profile (new) | exit 0 · 2/2 | NFR-01 load sanity |
| replay-determinism (new) | exit 0 · 6/6 | NFR-07/FR-30 part (a) |

Prior-attempt harness note: t102/t103/t104/t105 were authored pre-gate; the prior verifier patched them to log in (run-scoped `X-Forwarded-For`, password read from `.env` in-script, never echoed) and probe the public `/api/health` for up-checks. Reviewed and adopted as-is; all five ran green unchanged this session.

## 2. FR GWT matrix (spec §4 M1 acceptance set + related)

| Requirement | Claim | Evidence |
|---|---|---|
| FR-01 dedupe: 202 → 200 `deduped:true`, exactly 1 row | [VERIFIED] | t102 1a–1c |
| FR-01 unknown `type` → 400 + field error, no row | [VERIFIED] | t102 2 |
| FR-01 rate limit 429 + Retry-After (RT-02) | [VERIFIED] | t102 5 (40/40 429) |
| FR-02 read-your-write, `type=` filter, no update/delete paths | [VERIFIED] | t103 1b; t110 3; route source has GET/POST only |
| FR-03 queued→running→succeeded, artifact row+file, sha match | [VERIFIED] | t104 1–2; t105 1–2 |
| FR-03 `budgetMs:1` → failed `budget_exceeded`, loud | [VERIFIED] | t104 4a–4b; contributes the 14 `failed` jobs visible in metrics |
| FR-05 crash-between → exactly one downstream effect | [VERIFIED] | t103 3a–3b |
| FR-06 empty DB → explicit empty states, zero fake numbers | [VERIFIED] | t108 + walkthrough (pinned copy rendered pre-seed in 5-e); tiles fetched real endpoints |
| FR-08 seeded rows carry SYNTHETIC (server-stamped) | [VERIFIED] | t106; RT-12 re-stamp t102 4; UI badges walkthrough |
| FR-07 kill -9 mid-job → never stuck, never lost | [MEASURED] | t104 stage 5 ×3 (30 jobs across 3 kills: all terminal, none `running`) |
| FR-27 lease sweep resumes from checkpoint | [VERIFIED] | t104 stage 6 ×3 (attempts=2, `jobs.recovery` events) |
| FR-28 backup + restore drill | [MEASURED] | §3 drill row; backupId=265 (14,653 B tar, 36 ms) |
| FR-29 authz matrix (public vs session-gated) + throttle | [VERIFIED] | t107 12/12; walkthrough logout→gate |
| FR-30 replay → sandbox offsets, deterministic | [MEASURED] | §4 two-part chain |
| FR-31 DLQ visible + re-drive endpoint validation | [VERIFIED] | t106 redrive 400/404; Pipeline DLQ section renders |
| FR-09 health `{ok,db,version,uptimeS}` | [VERIFIED] | t107 4 (`db:up`), walkthrough footer dot |
| FR-10 shell: registry tabs, sticky footer, 44px targets, ARIA | [VERIFIED] | t108; walkthrough: landmarks/aria-current/aria-labelled sparkline |
| FR-17 Stream renders viewer.sample + ai.exchange live | [VERIFIED] | t110; walkthrough (6,175 viewers, sparkline, newest-first tail) |
| RT-05 one REAL external userscript event in M1 acceptance | [UNVERIFIED] | **OPEN — owner-side step** (docs/runbook.md §2); path verified only with panel-source events |

## 3. NFR measurements (the three named numbers in bold)

- **NFR-01 ingest p95 = 5.69 ms < 100 ms — PASS [MEASURED].** Server rolling window (last-500, `GET /api/metrics`): **p50 2.27 ms · p95 5.69 ms · n=250**; eventsPerMin 510 after load. Profile: seed {250} (eventsCreated=250, jobsQueued=5, 781 ms wall, eventsPerMin 256) + 250 events through public `POST /api/events` (all 202, zero 429, rotated run-scoped IPs ≤25 req/IP < 30/min). Client-observed (secondary): p50 7.0 ms / p95 14.0 ms. Honest caveat: the latency window is fed only by the public ingest route — the seed leg alone cannot produce p95 (documented in tests/load-profile.sh header).
- **NFR-02 restore drill = 18 ms < 60 s — PASS [MEASURED].** Copy newest `backup-*.db` → `/tmp/drill-restore.db` → readonly `bun:sqlite` → `PRAGMA quick_check` ok → row counts Event 1823 / Job 273 / Artifact 264 / Outbox 1823 all match live baseline (Artifact 265 post-backup = the backup's own row, by construction). Zero acknowledged-event loss across 3 kill-9 rounds (see NFR-02 second clause).
- **Kill-9 ×3 = 3/3 PASS [MEASURED].** verify-t104 fresh runs 1–3, each `exit 0` with the stage-5 SIGKILL recovery GWT green (10 jobs/run, all terminal ≤45 s after restart, none stuck `running`).
- NFR-03 external spend = 0 [VERIFIED by architecture: M1 routes touch no external service]; ConnectorRun rows are M2.
- NFR-04 secrets: `gitleaks` ABSENT in sandbox → regex sweep over `git ls-files` (148 files, excl. `.env.example`/`docs/prior-art`/package-lock): **0 key/token hits** (`ghp_/ghu_/sbp_/sb_secret_/sb_publishable_/sk-/AKIA/PRIVATE KEY`); 8 `password=`-shaped lines all harness `.env` reads (value never echoed). `.env` untracked + `.gitignore` `.env*` [VERIFIED].
- NFR-05 no silent drops [VERIFIED]: t103 duplicate-key idempotency; t105 integrity_error event on missing file; DLQ renders.
- NFR-06 structured log lines [VERIFIED]: `{layer,component,task_id,event,ts}` observed in dev.log; dev.log clean this session (0 × 500/503/tick_error).
- NFR-07 replay determinism — PASS [MEASURED], two-part chain in §4.
- NFR-08 mobile/ARIA [VERIFIED]: 375 px scrollWidth == viewport (no horizontal overflow), single-column stack, scrollable tab row; aria-labelled input/tabs/sparkline.
- NFR-09 SYNTHETIC labelled in API + UI + docs [VERIFIED]: server stamping (t106), amber badges in walkthrough, footer legend "SYNTHETIC = generated data".
- NFR-10 English everywhere [VERIFIED]: UI copy + docs reviewed in walkthrough.

## 4. NFR-07/FR-30 determinism — two-part reasoning chain

1. **Content determinism (job level) — [VERIFIED].** verify-t105 stage 3: two manual `sample.transform` jobs over the SAME event produce identical artifact sha256 (`3c = ba8a23eba67630749db0dcdc7a2dfcb6b24730e7bfa662a873272e6941aeb20c`). Artifact bytes are a pure function of event content.
2. **Set determinism across replays (dedupe path) — [MEASURED].** tests/replay-determinism.sh: fresh range [1821..1823] (3 replayable events, marker-checked never replayed) → replay 1: jobsQueued=3, all succeeded, sha256 set {24ae6de2…, a6794502…, ed190f9f…}; replay 2 (same range): jobsQueued=0, jobsDeduped=3, consumerResult skipped=3 (sandbox offsets) → sha256 set **identical**. Replay keys are `replay:<from>-<to>:<eventId>`, so a second replay cannot mint divergent artifacts; combined with (1), identical sha256 sets across two replays of any range hold by construction and are measured here.

## 5. Lint + preflight

- `bun run lint` → **exit 0** (repo-wide, including tests/).
- `python3 ops/preflight.py` → exit 0; masked summary: DATABASE_URL SET; **MISSING (required): GITHUB_PAT, REDIS_URL, NEXUS_API_TOKEN, SESSION_SECRET, ENCRYPTION_KEY, ANTHROPIC_API_KEY** — honest pre-G5 reality; M2-owned (vault/connectors). Note: preflight checks the process environment; `SESSION_SECRET`/`PANEL_PASSWORD` exist in `.env` (names verified only; loaded by the dev server — auth suites prove the secret is present and functioning).

## 6. Browser walkthrough (agent-browser, Chromium)

Path: `/` → gate → login → Overview → Pipeline → Seed 20 → expand row → Stream → 375 px checks → Log out → gate. **Zero page errors; console shows only dev-mode HMR/React-DevTools info lines. No broken interactions.**

Observed live: Overview tiles (events/min 0 at idle poll; ingest latency p50 2 ms · p95 6 ms · 250 samples; jobs queued 0/running 0/succeeded 262/failed 14/deadletter 0 — the 14 `failed` are the loud `budget_exceeded` GWT stages); Seed 20 toast quotes server numbers ("eventsCreated: 20 · jobsQueued: 1"); SYNTHETIC amber badges on seed rows; row expand renders JSON audit; Stream tab: **6,175 current viewers @ speci**, last sample <1 min, 30-sample sparkline, source `seed` + SYNTHETIC, `!AI exchanges` newest-first (#1849…, tail buffer correct); footer "NEXUS OS · L0 substrate live · v0.2.1 · SYNTHETIC = generated data" + health dot; Log out → "Signed out" toast → gate re-shown.

Screenshots: `agent-ctx/verify/01-login-gate.png` · `02-overview.png` (prior attempt) · `03-login-gate.png` · `04-overview-live.png` · `05-pipeline-seed20.png` · `06-pipeline-row-expanded.png` · `07-stream.png` · `08-mobile-375-overview.png` · `09-mobile-375-pipeline.png` · `10-logout-gate.png`.

## 7. Findings (review-only; no production code changed)

- **F-1 (medium, non-blocking) — oldest-window reads on `/api/jobs` + `/api/artifacts` and their UI consumers.** Both routes `orderBy: {id: 'asc'}` with `limit` (src/app/api/jobs/route.ts:123, src/app/api/artifacts/route.ts:59), so once logs exceed the window they return the OLDEST slice. Measured live: Overview "Latest artifacts" tile shows artifacts #1–#5 (~2 h old, labeled "Latest"); Pipeline Events shows #13–#25 while the log is at #1853. Same defect class 5-f already fixed for `/api/events` inside stream.tsx (rolling tail buffer, copyable per 5-f handoff). Data is real, §8 states honored, all GWT unaffected — but "latest" semantics are wrong on three surfaces at scale. Recommend: adopt the fetchTypeTail pattern (or `orderBy desc` + since-paging contract amendment at a gate) in M2 kickoff, not a mid-M1 contract change.
- **F-2 (note, by-design) — ingest latency window excludes seed/replay ingestion paths.** Only public `POST /api/events` records samples; metrics p50/p95 therefore measure the public path (the userscript path) — correct for NFR-01's intent, documented in tests/load-profile.sh.
- Harness-only changes this session: tests/restore-drill.sh, tests/load-profile.sh, tests/replay-determinism.sh (new, untracked) + prior attempt's t102–t105 session-gating patches. No production file touched.

## 8. OPEN (blocks full M1 exit, not verifier-side)

- **RT-05 real event [UNVERIFIED → owner]:** install the docs/runbook.md §2 userscript, point `PANEL_INGEST_URL` at the panel, let one real `viewer.sample` land, confirm Stream tab shows source `userscript` WITHOUT the SYNTHETIC badge. Everything verifier-side is green and ready for that event.

## 9. Verdict

**SIGN-OFF-WITH-FINDINGS** — all M1 GWT + NFR battery green ([MEASURED] p95 5.69 ms · drill 18 ms · kill-9 3/3 · replay sets identical; lint clean; secrets clean; walkthrough error-free), with F-1 recorded for M2 and the RT-05 owner-side real event outstanding before G5 pre-merge [H].

## Addendum (orchestrator, post-verifier): F-1 disposition — FIXED

Finding F-1 (oldest-window slices on "Latest" surfaces) was fixed in the same session:
- spec v1.3 §11: list GETs gained `order=asc|desc` + `before=` (exclusive upper bound), full desc pages return `nextBefore` — read-only sort/pagination toggle.
- Routes: /api/events, /api/jobs, /api/artifacts (+ UI overview/pipeline call sites) now read newest-first server-side; bogus order → 400 [VERIFIED].
- Re-verification: t105/t107/t108/t110 all exit 0; browser pass confirms "Latest artifacts" shows #272→#268 (1–12 min old, not 2 h) and Pipeline events #1872→#1869 newest-first; screenshots agent-ctx/verify-lead/11–14.
- Stream tab's earlier tail-read buffer (5-f) remains as-is (works; simplification deferred to M2).

## Addendum — G6 opened by owner directive (2026-10-29): RSI Lab v35.0 (experimental)

The owner directed the eval modules to start (RSI harness evolution, smart upgrade cycles). The Eval tab is now the RSI Lab: L3 frozen suites + L4 gated cycles.

- L3: 5 frozen suites (persona-tr, research-grounding, safety-refusal, reliability-latency, harness-discipline; 23 single-shot tasks) seeded from `src/data/rsi/eval-design.json` (research contract `nexus-rsi-eval-v1`), each sealed with a sha256 `configHash` at seed time; the AUDIT stage re-verifies the hashes (tamper evidence per 2609.00069).
- L4: cycle spine scout→thesis→synthesize→shadow-eval→pareto-gate→canary→promote→audit→record with gates G1 non-regression, G2 Pareto, G3 regularization (RRSI 2609.24972), G5 abstention, G7 budget (daily call cap, loud `budget_exceeded`), G8 hash-chain audit. G4 counterfactual registry and G6 judge anchor battery are **PENDING** until authored — reported honestly in gate output, never faked.
- Promotion requires an explicit owner confirm in the panel; deploy to the edge cortex remains a separate manual owner action.
- All run metrics are live-measured (real provider-ladder calls, engine truth recorded per task); failures are stored as failures; no improvement claims until the first full cycle completes [UNVERIFIED].
- Design provenance: `rsi-lab-research/` (evolution-engine.json `nexus-rsi-engine-v1`, eval-design.json, curation-papers.json — 48 owner-curated papers, arXiv-abstract-verified).
