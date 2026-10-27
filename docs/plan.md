# NEXUS OS — Continuation Plan (Round 10 proposal, awaiting owner gate)

_Date: 2026-10-23 · Basis: docs/research.md (R1–R5) + directive §3 phase pipeline · Status: **PROPOSAL — G4 approval pending**. On owner "go", M3 starts with T-300._

## M3 — Substrate hardening + walking skeleton (L0→L1 first vertical slice)

Goal: the directive's L0 proof-of-done on a real task: "Restart mid-job loses nothing; replay is deterministic; backup/restore measured" — proven by the fetch-and-record skeleton.

| Task | Scope | Contract / acceptance (abridged) |
|---|---|---|
| **T-300** SQLite WAL + seq hardening | prisma (migration), lib | WAL journal mode; monotonic `seq` on Event; `VACUUM INTO` backup script → `upload/backups/`; restore drill measured once |
| **T-301** JobStore + lease-claim table | lib/jobs | `Job` model (type, payload, state, claimedUntil, heartbeat, checkpoint JSON); claim/renew/complete/fail typed API; no dual claim under concurrency test |
| **T-302** Runner singleton | instrumentation.ts + runner | boot-safe loop; polls JobStore; per-step checkpoint writes; graceful shutdown; **kill -9 at step k → resume k+1, exactly-once, no event gap, byte-identical artifact** |
| **T-303** L1 tool registry v1 | lib/tools | zod→JSONSchema registry; 4 launch tools: `hyperbrowser.scrape`, `hyperbrowser.extract`, `upstash.emit`, `github.repo_info`; per-tool contract test + failure-mode doc; serialized Hyperbrowser sessions (1-concurrent limit) |
| **T-304** run.* event contract | lib/events | zod-frozen `run.started/step.completed/artifact.written/run.completed/run.failed/run.budget` with budget fields; Stream tab renders runs honestly (no mock data) |
| **T-305** Fetch-and-record skeleton | panel + runner wiring | Panel Run button → job → scrape 1 URL → artifact `upload/artifacts/<runId>/` + sha256 manifest → events live in Stream; Given/When/Then suite green |
| **T-306** Backup/restore proof | scripts | measured drill: SQLite VACUUM INTO + artifacts tar → restore into wiped db → panel healthy; time recorded; **gate: M3 [G5-style owner sign-off]** |

Estimate: 1–2 sessions. All $0, no new credentials.

## M4 — Brain (L2 orchestration on the measured SDK surface)

| Task | Scope | Contract / acceptance |
|---|---|---|
| **T-310** Brain route + guardrails | api/brain | chat-completions wrapper: AbortSignal timeout, model pinned + name-verified, usage captured; burst-profile test before unattended use |
| **T-311** Agent loop + checkpoints | lib/brain | tool-call loop (native OpenAI tool-calling, [MEASURED]) over T-303 registry; per-step SQLite checkpoints; `maxSteps`/`max_tokens` bounds; crash → resume |
| **T-312** Budget enforcement | lib/budget | pre-call daily caps from Settings whitelist; typed `BUDGET_EXCEEDED`; `brain.usage` L0 events; panel shows burn |
| **T-313** AgentRun/AgentStep/MemoryItem | prisma | episodic memory v1; task context assembly; run history in panel |
| **T-314** Brain×skeleton integration | wiring | LLM plans the fetch-and-record run within budget; unattended end-to-end within token/time budget (directive L2 proof-of-done); **gate: owner watches one live run** |

Estimate: 1–2 sessions. Groq/Edge-Function lane stays **deny-by-default** (owner may open it with a budget).

## M5 — Eval harness + first gated improvement (L3→L4, the RSI loop)

| Task | Scope | Contract / acceptance |
|---|---|---|
| **T-320** Frozen eval set v1 | eval/frozen | 40 items JSONL (families extract/write/plan/safety/regress; ≥10 safety); hash-locked MANIFEST; owner approves the set (G-gate: **owner-owned, version-frozen**) |
| **T-321** Eval runner | eval/runner | fixture-replay offline-first; graders deterministic/programmatic/rubric-judge (judge isolated, judge strength measured); K=3 seeded runs |
| **T-322** Paired comparison + report | eval/report | paired bootstrap 10k + sign test; pass^1/pass^3; delta with variance + cost/latency; contamination 8-gram scan |
| **T-323** Variant registry + CI path-guard | lib/variants + tests | `variant/<id>` bundles; guard: diffs touching eval/**, thresholds, scorers, observability = red; hashes to L0 before scoring |
| **T-324** PR-as-gate promotion | github connector + panel | promotion = bot opens PR (branch `variant/<id>`) → **owner merges** (bot has no merge rights) → one-command rollback = revert; Eval tab: champion vs variant pairwise, variance + cost shown; **gate: first real promotion with measured delta** |

Estimate: 2 sessions + owner gate. Prohibitions enforced mechanically (R5 table).

## Standing asks (owner)

1. **[CRITICAL, durability]** Create the private GitHub remote → agents push every task (P8). Today the only off-process copies are the platform snapshot + upload/ mount [MEASURED: no git remote].
2. Approve M3 start (this plan). ③ Later (M5): add `Pull requests: write` to the bot's GitHub scope when T-324 nears. ④ Optional: QStash token (default skip) · open Groq budget gate (default closed) · Edge Function `verify_jwt=false` + NEXUS_SHARED_SECRET lane (default yes, M4 optional).
3. Re-paste Upstash — **DONE this round** (verified CONNECTED, 172ms).

## What we deliberately do NOT do (non-goals honored)

No multi-tenant anything; no unbounded self-modification (L4 is PR-gated, eval set owner-owned); no dependency on TextGrad/inspect/etc. (pattern donors only); no Supabase Storage/Postgres writes v1 (PAT can't); no QStash v1; no dashboards without live data behind them (zero theatre).
