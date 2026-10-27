# docs/spec.md — NEXUS_BOT / NEXUS OS control panel

**Status:** **FROZEN AT G2 [H] (owner, 2026-10-21) — v1.2.** v1.1 resolved red-team blockers RT-01..RT-09/11/12/15 (see redteam.md); RT-10 accepted-with-schedule (FR-32). v1.2 = G4 hardening clarifications (FR-02 `type` filter, FR-06 metrics endpoint, FR-31 redrive endpoint, §11 full M1 surface) — traceability in plan.md §7. Unanswered §10 open questions **BOUND at G2 by silence** (§10 rule): OQ1 env-password auth in M1 · OQ2 public rate-limited ingest · OQ3 Supabase-first connector order · OQ4 Supabase OAuth+PAT dual-path · OQ5 prior-art-derived eval seeds.
**Date:** 2026-10-21 · **Owner:** single operator · **Inputs:** scope.md §10 (A1–A10), research.md, redteam.md, ADR-001/002/003
**Reading order for agents:** directives → scope.md → this file → plan.md → STATE.md
**Freeze rule (P3/P4):** no implementation file is written before the criterion it satisfies exists here. Contracts below (event envelope, API shapes, data model, tab registry) are the cross-agent coordination primitive — changes only at a gate.

---

## 1. User stories (single operator)

- **US-01** I open the panel and see live system state — events, jobs, artifacts, metrics. Real data only; a tile with no source behind it is a defect.
- **US-02** I trigger a job and watch it run to an artifact, within its budget.
- **US-03** I connect GitHub with one click (OAuth, no PAT) so snapshots/backups push without token babysitting.
- **US-04** I connect Supabase / Upstash / Hyperbrowser / Webshare from Settings — OAuth-first, keys only as labeled fallback.
- **US-05** I see my stream's **viewer count** and **`!AI` bot exchanges** live (nothing more — A10).
- **US-06** (M3/M4) I evaluate variants on a frozen set, promote at a gate, roll back with one command.
- **US-07** I restart the whole system and lose nothing.

## 2. Milestone map

| Milestone | Layers | Content | Gate |
|---|---|---|---|
| **M1 walking skeleton** | L0 (+UI shell) | Ingest → log → job → artifact → live tile; restart-safe; synthetic load generator; **userscript dual-target config (RT-05: one real external event in M1 acceptance)**; recovery/backup/replay/auth per FR-27..31 | G5 pre-merge |
| **M2 operator surface & connectors** | L1 (+UI) | Settings/vault, Connect GitHub (device flow), Supabase/Upstash/Hyperbrowser/Webshare connectors, Kick ingest contract | G5 |
| **M3 evaluation harness** | L3 | Frozen set, paired runs, variance, cost/latency telemetry, regression suite | G5 + owner gate |
| **M4 improvement loop** | L4 (+L2 depth) | Variant registry, sandbox eval, gated promotion, one-command rollback; cloud-parity prep | G6 release |

M2–M4 FRs are frozen at requirements level now; their detailed Given/When/Then lands as a spec amendment at each milestone kickoff (A5 cadence). M1 GWT below is complete.

## 3. Data model (Prisma, SQLite — ADR-001; forward-only migrations)

```
Event        id (auto-inc, monotonic) · type · source · payloadVersion · payload (JSON)
             occurredAt · ingestedAt · synthetic (bool) · idempotencyKey (unique, nullable)
Outbox       id · eventId → Event · topic · status (pending|done|failed) · attempts
             lastError · nextAttemptAt · createdAt
Job          id · type · status (queued|running|succeeded|failed|deadletter) · payload (JSON)
             checkpoint (JSON) · budgetMs · attempts · runId · idempotencyKey (unique)
             artifactId? · startedAt · endedAt · lastError
             leaseUntil (ISO) · heartbeatAt (ISO)      // RT-01: liveness + recovery sweep
Artifact     id · jobId? · kind · path · sha256 · bytes · createdAt
ConsumerOffset topic · consumer · lastEventId (unique on pair)
Credential   id · service · name · scopes · status (active|invalid|revoked) · valueCipher
             keyId · createdAt · updatedAt · lastVerifiedAt      // value never plaintext at rest
Setting      key (unique) · value (JSON) · updatedAt              // non-secret config only
DeviceFlow   id · provider · deviceCode · userCode · intervalS · expiresAt
             status (pending|complete|denied|expired)             // GitHub/Supabase device or code flow state
ConnectorRun id · connector · operation · status (ok|error) · latencyMs · summary
             createdAt                                            // audit metadata only, no secrets
```

**Checkpoint schema (frozen, RT-01):** `{ "step": "string", "stepIndex": n, "outputs": {"artifactId?": id, "hashes": [sha256]}, "updatedAt": ISO }` — runner heartbeats every 5s (lease = 15s); every checkpoint write happens **after** the durable effect it records (artifact file first, hash second, checkpoint row last).

**Event envelope (frozen contract, v1):**
```json
{ "id": 0, "type": "viewer.sample | ai.exchange | job.lifecycle | system.log",
  "source": "userscript | panel | pipeline | seed", "payloadVersion": 1,
  "payload": { }, "occurredAt": "ISO-8601", "synthetic": false }
```
Producers MUST set `synthetic: true` on generated data (NFR-09). **Ingest additionally enforces server-side (RT-12): `source=seed` ⇒ `synthetic=true` regardless of body.** Unknown `type` → rejected 400 (registry-checked; registry is code-frozen, additions via PR).

**Payload schemas (frozen, RT-06):**
- `viewer.sample`: `{ "viewers": int≥0, "channel": string }`
- `ai.exchange`: `{ "prompt": string≤2KB, "reply": string≤8KB, "modelLabel": string, "latencyMs": int, "intent": string }`
- `job.lifecycle`: `{ "jobId": string, "status": enum(Job.status), "cause?": string≤200 }`
- `system.log`: `{ "level": "info|warn|error", "component": string, "message": string≤500 }`

**Outbox topics (frozen):** `viewer`, `ai`, `jobs`, `system` — mapped 1:1 from event type; `topic(event)` is a pure function in the events module.
**Dispatch ownership (frozen):** jobs are created ONLY by explicit `POST /api/jobs`; the `jobs` topic consumer is the runner's state-announcer (emits `job.lifecycle`), never an auto-spawner. Other consumers may enqueue jobs via the API only (same limits).

**Tab registry (frozen contract):** `{ id, label, icon, order, requiredCredential? }` — initial tabs: Overview(1), Pipeline(2), Stream(3), Connectors(4), Eval(5), Settings(6). New tabs = registry entry + module; no shell rework (A4).

## 4. Functional requirements — M1 (walking skeleton)

- **FR-01 Ingest API** — `POST /api/events` with the event envelope (no `id`/`ingestedAt`) → `202 {eventId}`. Dedupe on `idempotencyKey` → `200 {eventId, deduped:true}` (concurrent same-key race: unique-violation retried once, then `deduped:true` — never 500, RT-11). Validation failure → `400 {error:{code:"validation", message, details:[{field,issue}]}}`. **Rate limit (RT-02): 30 req/min per IP, burst 5/s, body ≤ 32 KB; 429 carries `Retry-After`; sustained overload → 503 shed-load.**
- **FR-02 Durable event log** — append-only `Event` rows, monotonic ids; `GET /api/events?since=&limit=&type=` (default 50, max 200; `type` = optional registry filter, v1.2). No update/delete paths exist.
- **FR-03 Job runner** — `POST /api/jobs {type, payload, idempotencyKey, budgetMs}` → `202 {jobId}`. M1 job type `sample.transform`: consumes an event id, writes an artifact, checkpoints after each step. Status transitions only via runner; `GET /api/jobs?status=&limit=`. Budget exceeded → `failed` with cause `budget_exceeded` (loud, NFR-05).
- **FR-04 Artifact store** — artifacts under `artifacts/YYYY-MM/` + sha256/bytes row in DB. `GET /api/artifacts?limit=`, `GET /api/artifacts/:id` (stream file). Missing file vs row mismatch → surfaced as `integrity_error` event (never silent).
- **FR-05 Outbox + consumer** — every event fans out via `Outbox` to topic consumers; `ConsumerOffset` per (topic, consumer); at-least-once; consumers idempotent by key. Failed deliveries retry with backoff, then `failed` status (visible), never dropped.
- **FR-06 Live dashboard** — Overview tiles: events/min, jobs by status, latest artifacts, ingest latency p50/p95. Each tile fetches a real API; tooltip names the endpoint (events/min + ingest latency p50/p95 + jobs by status + queue depth from `GET /api/metrics` v1.2; latest artifacts from `GET /api/artifacts`). Loading = skeleton; empty = explicit empty-state copy; error = toast + retry. Poll ≤ 2s (NFR-01).
- **FR-07 Restart safety** — kill -9 mid-job: on restart, runner resumes from `checkpoint` or fails to `deadletter` with full run record. Acknowledged events are never lost (NFR-02).
- **FR-08 Synthetic load generator** — `POST /api/dev/seed {count}` (**session-gated, count ≤ 500**, RT-02) inserts events/jobs with `synthetic: true` (server-enforced); UI shows a `SYNTHETIC` badge on anything synthetic (API, UI, docs — NFR-09).
- **FR-09 Health** — `GET /api/health` → `{ok, db:"up|down", version, uptimeS}`.
- **FR-10 Panel shell** — tab-registry-driven single-route app at `/`; mobile-first responsive; sticky footer (`min-h-screen flex flex-col` + `mt-auto`); 44px touch targets; semantic landmarks + ARIA.
- **FR-27 Startup recovery (RT-01)** — on boot, sweep jobs: `running` with expired lease → re-queue from checkpoint (attempts+1, max 3 → `deadletter`); `running` with fresh lease → leave. Emit `system.log` per action.
- **FR-28 Backup/restore (RT-04)** — `POST /api/dev/backup` (session-gated): SQLite `VACUUM INTO` + artifacts tarball → one backup artifact row; keep last 10. Runbook documents the restore drill; **drill executed and timed in M1 acceptance** (reconciles NFR-02).
- **FR-29 Panel auth (RT-07, resolves OQ1)** — owner password from env (`PANEL_PASSWORD`); login sets signed HttpOnly SameSite=Lax cookie (`SESSION_SECRET`, 7-day expiry); login throttle (5 fails → 15-min lock); logout invalidates. **Authz matrix:** public = `GET /api/health`, `POST /api/events` (rate-limited); session-gated = every other `/api/*` incl. `/api/dev/*`, `POST /api/jobs`, settings, credentials.
- **FR-30 Replay (RT-09)** — `POST /api/dev/replay {fromEventId, toEventId}` (session-gated) re-drives the range through all consumers into a **sandbox offset namespace** (side-effect-free duplicates write artifacts with `replayOf` marker). Deterministic = identical artifact sha256 sets across two replays of the same range.
- **FR-31 Retention & DLQ surface (RT-02/12)** — config defaults: events 30d, artifacts ≤ 500 files/200 MB, backups 10, enforced by sweep (session-triggered + on boot). DLQ renders as a Pipeline-tab section with cause/attempts and a **manual re-drive** button → `POST /api/dev/redrive {kind:"outbox"|"job", id}` (v1.2: failed outbox rows → `pending` with `nextAttemptAt=now`; deadletter jobs → `queued`, attempts preserved for audit).

**M1 acceptance (GWT, selected critical paths):**

- **FR-01** Given a valid envelope with a new `idempotencyKey`, When POSTed twice, Then first returns 202, second returns 200 `deduped:true`, and exactly one Event row exists.
- **FR-01** Given a payload with unknown `type`, When POSTed, Then 400 with the field error and no Event row.
- **FR-03** Given a queued `sample.transform` job, When the runner ticks, Then status goes queued→running→succeeded, one Artifact row + file exist, and sha256 matches the file.
- **FR-03** Given `budgetMs: 1` on a job needing >1ms, When executed, Then status `failed`, cause `budget_exceeded`, visible in jobs list and DLQ view.
- **FR-07** Given a running job, When the server is killed and restarted, Then the job is `succeeded` from checkpoint or `deadletter` with cause — never stuck `running`, never lost.
- **FR-05** Given 3 events of a topic, When the consumer runs twice (simulated crash between), Then each downstream effect occurs exactly once (idempotency by key).
- **FR-06** Given an empty database, When Overview renders, Then tiles show explicit empty states and zero fake numbers.
- **FR-08** Given a seeded batch, When viewing any seeded row/tile contribution, Then the `SYNTHETIC` badge is present.

## 5. Functional requirements — M2 (operator surface & connectors; GWT at kickoff)

- **FR-11 Credential vault (ADR-002 + A8)** — encrypted-at-rest **(crypto contract, RT-08): AES-256-GCM (WebCrypto), per-record random 12-byte nonce, AAD = record id, ciphertext blob prefixed with keyId**; rotation sweep re-encrypts under new key-id (endpoint, M2); tamper → record marked `invalid` + `system.log error` (GWT at M2 kickoff). Create/update **write-only** (values never rendered, logged, or returned); list shows service/name/scopes/status masked; audit = metadata only. OAuth-first UX: provider card shows Connect button when OAuth exists; key entry is the labeled fallback with warning.
- **FR-12 Connect GitHub (ADR-003)** — Settings card: Connect → device code display → polling status → connected state (account, repo, expiry). Auto-refresh before 8h expiry; rotation persisted **only after a successful probe call with the new token** (refresh-race recovery, RT-08); on rotation failure keep old state + surface `reauth_required`; Disconnect revokes server-side. Actions: check repo (Metadata), create repo if missing (Repository creation), snapshot-push `docs/` + `STATE.md` (Contents RW).
- **FR-13 Connect Supabase (research 2-a)** — primary: OAuth2 authorization-code + PKCE (Beta-flagged endpoints; confidential client; scopes fixed at app creation) → tokens refreshed server-side; fallback: scoped PAT `sbp_fc…` with Edge Functions RW + Edge Function Secrets RW (no OAuth available to the account = explicit fallback case). Operations: health check, invoke `nexus-cortex` (function URL + `apikey`), drain `nexus_stream_events` → L0 events (idempotent by row id), upsert edge secrets via Mgmt API (write-style modification, values masked; `GET /secrets` existence-check only, never persisted).
- **FR-14 Connect Upstash (research R3)** — REST token credential; ping/stats; optional stream mirror behind the event-bus interface (XADD via REST, non-blocking XREADGROUP poll). Off by default; enabling records a ConnectorRun.
- **FR-15 Connect Hyperbrowser (research R3)** — API key; session create/status/stop; consumed by L2 task types from M3+; budgeted.
- **FR-16 Connect Webshare (research 2-b, A9)** — API credential (`Authorization: Token …`); list proxies (never rendered in full — count + country histogram only), plan/bandwidth stats, IP-authorization helpers (`/whatsmyip/`, add/remove). **Proxy routing module: OFF by default**; enable only on a recorded measured need; traffic via Backbone `p.webshare.io` endpoint preferred (survives list rotation).
- **FR-17 Kick ingest contract (A10)** — userscript posts exactly two event types: `viewer.sample` (periodic, default 60s, {viewers, channel}) and `ai.exchange` ({prompt, reply, modelLabel, latencyMs, intent}). Contract documented + versioned; ingest rate-limited/size-capped; Stream tab renders both live. Channel-level logs explicitly excluded (A10).
- **FR-18 Settings & budgets** — panel session auth per FR-29; per-job-type budget defaults (wall-clock + tokens + cost, wired to FR-32 at M2); ingest rate-limit config; theme. All non-secret values in `Setting`.
- **FR-32 Model gateway actor (RT-10; GWT at M2 kickoff amendment)** — server-side model invocation for bot-reply task types (built-in gateway first, per scope §6); `Job` gains `tokenBudget`/`costBudget` columns and every model call records tokens/cost/latency on its `ConnectorRun`; budgets enforced loudly (fail `budget_exceeded`, cost recorded even on failure). Feeds NFR-03 and M3 telemetry.

## 6. Functional requirements — M3/M4 (requirements level)

- **FR-19 Frozen eval set** — versioned, owner-owned corpus at `docs/eval/` (agent-immutable per directive §5A); items carry failure-category taxonomy inherited from prior art.
- **FR-20 Paired eval runs** — variant vs champion, same budget + seed policy; scores reported with variance across ≥2 clean runs; cost + latency per item; results are artifacts.
- **FR-21 Regression suite** — safety/latency/cost ceilings checked per run; failures block promotion.
- **FR-22 Contamination + claim tags** — eval items may not be tuned against; reports carry [VERIFIED]/[MEASURED]/[INFERRED]/[UNVERIFIED] tags.
- **FR-23 Variant registry** — `variant/<id>` named, hypothesis recorded before run.
- **FR-24 Sandbox evaluation** — proposed prompt/policy/tool changes evaluated in isolation before any promotion.
- **FR-25 Gated promotion + rollback** — promotion only at human gate; one-command revert; ADR recorded per promotion/rejection (negative results recorded, never silently discarded).
- **FR-26 Prohibition enforcement** — agent-role permissions exclude eval-set/threshold/telemetry/gate-logic mutation; RSI kill-switch (singleton config) honored end-to-end.

## 7. Non-functional requirements

| ID | Requirement | Verify |
|---|---|---|
| NFR-01 | Ingest p95 < 100 ms under the M1 load profile (**50 events/min × 5 min via seed, RT-09**); tile poll ≤ 2 s | M1 load sanity |
| NFR-02 | Zero loss of acknowledged events on kill -9; **restore drill executed + timed at M1** | M1 restart test + FR-28 drill |
| NFR-03 | M1 external spend = 0; every model/connect run records cost + latency | ConnectorRun rows |
| NFR-04 | No secret in client bundle, API responses, logs, commits; gitleaks pre-commit; ingest rate-limited + size-capped (≤ 32 KB); panel session-gated; server-only modules for secrets (`server-only` import) | gitleaks + code review + red team |
| NFR-05 | No silent drops: DLQ with runId/attempts/cause; budgets fail loudly | M1 GWT |
| NFR-06 | Every log line: `run_id, task_id, layer, component` | log audit at G5 |
| NFR-07 | Deterministic replay per FR-30 semantics (identical artifact hashes across 2 replays) | M1 replay test |
| NFR-08 | Mobile-first, 44px targets, semantic + ARIA, keyboard navigable | UI walkthrough |
| NFR-09 | Synthetic labelled in API + UI + docs; claim tags on reports | G5 checklist |
| NFR-10 | English everywhere (UI copy, docs, commits) | review |

## 8. Error / empty / loading UX (binding for all tabs)

| State | Rule |
|---|---|
| Loading | Skeleton in the exact final layout; no spinners-in-voids |
| Empty | Explicit copy naming what will appear here + how to produce it ("No events yet — POST /api/events or run seed") |
| Failure | Toast with action ("Retry"); tile keeps last-good data with `stale` chip |
| Stale | Data older than 3× poll interval shows `stale` chip; never silently old |
| Integrity | `integrity_error` events surface in Pipeline tab; never auto-hidden |

## 9. Explicit non-goals (v1)

Directive §0 non-goals stand. Additions from owner amendments: channel-level Kick logs (A10); speculative proxy routing (A9 — enabled only on measured need); multi-tenant auth (single operator); Google/other OAuth sign-in (parked, backlog — auth provider abstraction noted in FR-18); SaaS billing.

## 10. Open questions for G2 (each with default)

1. **Panel session auth (M1):** owner-set password from env + signed cookie, vs deferring auth to M2. **Default: env password in M1** (ingest endpoint stays public-but-limited; panel UI gated).
2. **Ingest auth for the userscript (M1):** public + rate-limit + size-cap, vs shared lightweight header the userscript can hold (kick.com page context = effectively public anyway). **Default: public + limits for M1**; rotate to a per-source token in M2 if abuse appears.
3. **M2 connector order:** Supabase first (Cortex drain is the flagship), then GitHub card, then Upstash/Hyperbrowser/Webshare. **Default: yes.**
4. **Supabase OAuth2 vs scoped PAT as the primary connect path** given Beta-flagged OAuth endpoints. **Default: build both; OAuth button primary, scoped PAT fallback** — matches A8 without betting M2 on a Beta.
5. **Eval seed content (M3):** derive initial items from prior-art failure categories, owner curates/approves 10 seed items at M3 kickoff. **Default: yes.**

*Unanswered open questions adopt their stated defaults at G2 (RT-15).*

## 11. Contract summary (P4 — frozen at G2)

- Event envelope §3 · tab registry §3 · data model §3
- API surface — **M1 (v1.3, full list)**: `POST/GET /api/events`, `POST/GET /api/jobs`, `GET /api/artifacts` (+`/:id`), `GET /api/health` (public), `GET /api/metrics` (session), `GET /api/dev/dlq` (v1.3 — FR-31 DLQ listing: failed outbox rows + deadletter jobs, metadata only), `POST /api/auth/login|logout`, `POST /api/dev/{seed,backup,replay,retention,redrive}` (all session-gated); **M2**: `/api/credentials`, `/api/connectors/*`, `/api/github/*`, `/api/settings`
- Auth split (FR-29, binding): public = `GET /api/health` + `POST /api/events` (rate-limited); every other M1 route requires the session cookie.
- Error shape: `{ error: { code, message, details? } }` — **single shape everywhere** (RT-11); `code="validation"` carries `details:[{field,issue}]`
- Success list shape: `{ items, nextSince? }` — **v1.3**: list GETs accept `order=asc|desc` (default asc) + `before=` (exclusive upper bound); full descending pages return `nextBefore` (min id) for older-page continuation. Read-only sort/pagination toggle for operator lists (red-team F-1 disposition: "Latest" surfaces MUST read newest-first).
- All mutation endpoints idempotent by caller-supplied key where a retry is meaningful.

## 12. Writer topology (RT-03, binding)

Exactly one writer process touches SQLite: the Next.js server (API routes + in-process runner). Future mini-services write **only through the panel's API**, never via direct Prisma access. Dispatch ownership per §3. Testable via NFR-11; upholds ADR-001.
