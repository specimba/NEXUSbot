# NEXUS OS — Round 11 Deep Research (Phase 1 Grounding)

**Date:** 2026-10-23 · **Method:** 4 parallel research scouts (R11-b/c/d/e) over primary docs, shipped app bundles, OpenAPI specs, and owner-provided dashboard data · **Claim tags:** [MEASURED] (ran it / owner dashboard / fetched source), [INFERRED] (docs reasoning), [UNVERIFIED] (needs a key or live test) · Companion journals: `docs/STATE.md`, `worklog.md`

---

## 0. TL;DR — the ten findings that shape everything

1. **The reset was real and instructive** [MEASURED]: the sandbox boots from `/home/sync/repo.tar` (written at pre-stop) and this session started with NO tar restore — rounds 1–10 were never persisted. Only the `upload/` OSS mount survived. P8 is now enforced mechanically: local git commits every task + GitHub remote (this round) + boot-time dev auto-start.
2. **Vyce's real API is live and OpenAI-shaped** [MEASURED]: `https://vyceai.com/v1` (base), `Authorization: Bearer sk-…`, `/v1/models`, `/v1/me` (balance), `/v1/chat/completions`, `/v1/messages` (Anthropic dialect), `/v1/images/generations`. Exact OpenAI error shapes + `request_id`. Per-key spend cap + rate limit at key creation. **Silent-fallback risk is real** (third-party audit observed stream rewriting on one model) → our router must pin + verify `response.model` per call.
3. **Vyce free value is substantial** [MEASURED]: Free plan includes glm-5.3-flash at 10M tok/day + $10/day reward credits; Lite ($5/mo) makes deepseek-v4.1 + agnes-3.0-flash unlimited-burn.
4. **Groq's roster rotated** [INFERRED from trackers; verify at first key]: llama-3.x decommissioned Aug 2026; current: `openai/gpt-oss-120b|20b`, `qwen/qwen3-32b`, `qwen/qwen3.6-27b`, `moonshotai/kimi-k2-instruct-0905`, `llama-4-scout`. Free tier ≈ 30 RPM / 1,000 req/day. **No embeddings on Groq** (never had).
5. **The Supabase Management PAT is a full control plane — including key custody** [MEASURED]: `GET /v1/projects/{ref}/api-keys?reveal=true` returns publishable/secret key VALUES (scoped PAT needs API Keys Secrets Read). SQL exec, Edge Function deploy + secrets, logs (1-day retention), backups list/restore, pause/restart. **PAT custody = the #1 secret of panel v2.**
6. **Supabase Edge Functions are our public entry point** [MEASURED]: the sandbox panel is not publicly reachable, but `https://{ref}.supabase.co/functions/v1/{name}` is (150 s wall clock, 256 MB, verify_jwt toggle). Pattern: KICK/GitHub/QStash webhook → Edge Function → Postgres (+ Upstash Redis mirror) → Realtime broadcast REST push → owner's browser. **Free projects pause after ~1 week of low user DB activity** → a daily QStash schedule → Edge Function → PostgREST write doubles as anti-pause heartbeat [INFERRED, docs-blessed].
7. **Legacy Supabase JWT keys (anon/service_role) die end-2026** [MEASURED] → all new code uses `sb_publishable_`/`sb_secret_` named keys.
8. **Upstash is six products, most USE NOW** [MEASURED]: Redis (250 MB / 500K cmds·mo — ratelimit + hot state), QStash (1,000 msgs/day, 10 schedules — needs the Edge Function receiver), Vector (10K queries+updates/day, auto-embed via `openai/text-embedding-3-small` — brain memory), Blob (1 GB — encrypted offsite backups), Box (5 CPU-hr/mo — burst runner only), Workflow (LATER — needs public endpoint; no Deno support yet).
9. **External data stack settled** [MEASURED]: Bright Data = SERP + Web Unlocker (5,000 credits/mo, renew 1st; proxies NOT covered); Exa = brain research tool ($28.74 ≈ ~7k searches); Hyperbrowser stays the ONE browser pool (per-session custom proxy = paid feature — Webshare egress blocked on free); Nebius PARK ($119; nothing worth activating now).
10. **KICK has an official API** [MEASURED]: dev.kick.com portal, OAuth 2.1 at `id.kick.com`, `api.kick.com/public/v1` (chat send/delete, channel read/write, webhooks via events:subscribe) — the bot should graduate from unofficial endpoints/Pusher to the official API, with Pusher WS as read-only fallback.

---

## 1. Target architecture (panel v2 + brain + bot)

```
 PUBLIC INTERNET                          SUPABASE (2 free projects)                        SANDBOX (not public)
 ───────────────                          ──────────────────────────                        ────────────────────
 KICK webhook ───┐                        ┌────────────────────────────────────┐
 GitHub webhook ─┼─POST──────────────▶    │ Edge Functions  /functions/v1/*    │◀──(Management PAT: SQL, deploy,
 QStash cron  ───┤  verify_jwt=false +    │  150s / 256MB, secrets per fn      │     keys-reveal, logs, backups)──┐
 Upstash events ▶┘  shared-secret header  │   │ supabase-js (sb_secret_)       │                                  │
                                          │   ▼                                │        NEXUS CONTROL PLANE       │
                                          │  Postgres (L0 events, rsi_config,  │        (Next.js, this sandbox)   │
                                          │  nexus_rsi_evaluations, spend      │◀─────────────────────────────────┘
                                          │  ledger, backups manifest)         │        · panel UI (owner browser,
                                          │   ├─▶ Realtime broadcast REST push │          public) via Caddy
                                          │   └─▶ Upstash Redis (hot counters, │        · vault (AES-GCM) re-entry
                                          │       rate limits, dedupe)         │        · brain router (Vyce+Groq)
                                          │                                    │        · research helpers
                                          │ Auth: passkeys (operator) ·        │
                                          │ OAuth 2.1 IdP (bot/MCP clients, P1)│        OWNER'S BROWSER
                                          │ pg_cron + pg_net (self-scheduling) │◀═══ WSS realtime (anon key+RLS)
                                          └────────────────────────────────────┘     + panel HTML from sandbox
```

**Division of labor:** Supabase = public data plane + webhooks + auth. Sandbox = control shell (UI, vault, router). Upstash = hot state + queue + memory + backups. Vyce/Groq = inference. Bright Data/Exa = acquisition/research. Hyperbrowser = browser pool. GitHub = code durability.

---

## 2. LLM brain: Vyce + Groq router

### 2.1 Vyce facts [MEASURED from shipped bundle + unauth probes]

| Item | Value |
|---|---|
| Base URL | `https://vyceai.com/v1` |
| Auth | `Authorization: Bearer sk-…` (per-key spend cap + req/min limit settable at creation) |
| Endpoints | `POST /v1/chat/completions` · `POST /v1/messages` (Anthropic) · `GET /v1/models` · `GET /v1/me` · `POST /v1/images/generations` (Grok Imagine 2) |
| Error shape | exact OpenAI: `{"error":{"message","type","code"},"request_id"}` |
| Context map | claude-sonnet-4-6(-pro) 270K · gpt-6-luna/astra 270K · glm-5.3-flash 500K · qwen3.8-flash 1M |
| Plans | Free: glm-5.3-flash 10M tok/day + $10/day reward credits; Lite $5/mo: unlimited deepseek-v4.1 + agnes-3.0-flash |
| Risk | proxy may rewrite/interfere with requests (lmspeed audit observed on one model) → **drift detection mandatory** |

**Live-probe plan (runs the moment the owner pastes a Vyce key into the vault):** ① GET /v1/models → diff vs dashboard catalog ② GET /v1/me → balance/quota shape ③ minimal chat on each pinned model → assert `response.model` == requested ④ streaming SSE check ⑤ tool-call check on glm-5.3-flash + claude-sonnet-4-6 ⑥ JSON-mode check on deepseek-v4.1 + gpt-5.6-terra ⑦ Anthropic-dialect usage accounting check ⑧ pricing audit (5 tiny calls vs balance delta). **Kill criterion:** any silent model substitution → demote Vyce to best-effort lane.

### 2.2 Groq current roster [INFERRED from trackers; re-verify with key at console]

Active: `openai/gpt-oss-120b` ($0.15/$0.60, 131k), `openai/gpt-oss-20b` ($0.075/$0.30), `qwen/qwen3-32b` ($0.29/$0.59), `qwen/qwen3.6-27b`, `moonshotai/kimi-k2-instruct-0905` ($1/$3, 262k), `meta-llama/llama-4-scout-17b-16e`. JSON mode + structured outputs + tool use confirmed. Free tier ≈ 30 RPM / 1,000 RPD. No embeddings. Endpoint `https://api.groq.com/openai/v1`.

### 2.3 Tier table (pinned IDs)

| Tier | Role | Primary | Fallback chain | Budget |
|---|---|---|---|---|
| T0 reflex (<1s) | intent, routing, KICK-chat reflexes | `deepseek-v4-flash-lr` (380ms, $0.15/$0.60) | glm-5.3-flash (free) → Groq `gpt-oss-20b` → T5 | 1.5s |
| T1 workhorse | chat, tool-loop steps | `deepseek-v4-flash` ($0.22/$0.66) | deepseek-v4.1 → Groq `qwen3-32b` → glm-5.3-flash | 15s |
| T2 heavy | planning, codegen, long-context | `claude-sonnet-4-6` ($3/$15, 270K) | deepseek-v4-pro → gpt-5.6-terra → Groq `gpt-oss-120b` | 120s |
| T3 judge (cross-family) | eval scoring, RSI gate | see pairings | — | 60s |
| T4 free lane | background jobs, degraded mode | glm-5.3-flash + Groq free | T5 | 30s |
| T5 last resort | sandbox z-ai SDK (zero spend) | — | — | 10s |

**Judge pairings (producer family ≠ judge family, per cortex v30 doctrine):** DeepSeek→claude-sonnet-4-6 or gpt-5.6-terra · Claude→deepseek-v4-pro or gpt-5.6-terra · OpenAI→claude-sonnet-4-6 or deepseek-v4-pro · Qwen/GLM→claude-sonnet-4-6. `claude-sonnet-4-6-pro` and agnes never judge.

**Mechanics:** pinned IDs + `response.model` drift detection (mismatch → auto-disable + alert) · per-provider circuit breakers · per-tier timeout budgets (AbortController) · cost ledger per request (`llm_spend`: ts, tier, model, tokens, est_cost, request_id) · Vyce spend alerts at 50/80/95% of balance ($297.25) — at 95% auto-demote non-judge traffic to T4 · Groq 429-aware with `x-ratelimit-*` headers.

### 2.4 Memory / embeddings decision matrix

| Option | Semantics | Extra vendor | Cost | Verdict |
|---|---|---|---|---|
| **Upstash Vector auto-embed** (`openai/text-embedding-3-small`, 1536d) | yes, query-by-text | none (already have Upstash) | free 10K upd+query/day | **RECOMMENDED for panel v2** (feature-flagged) |
| Supabase pgvector + local gte-small (384d) via Transformers.js | yes | none | free, but we run the embedder | P1 alternative (SQL-joined memory later) |
| SQLite FTS5 keyword | no | none | free | v1 default + durable fallback |

---

## 3. Supabase capability map (all [MEASURED] from OpenAPI spec + docs, 2026-10-23)

| Capability | Endpoint / limit | NEXUS use | Priority |
|---|---|---|---|
| Run SQL (incl. DDL) | `POST /v1/projects/{ref}/database/query` (+read-only variant, typegen) | schema bootstrap, migrations from panel | P0 |
| API keys retrieve/mint | `GET /api-keys?reveal=true` (values!), `POST /api-keys`, legacy JWT disable | post-reset re-entry WITHOUT re-pasting keys | P0 |
| Edge Functions lifecycle | `POST /functions/deploy` (multipart), secrets `GET/POST/DELETE /secrets` (100×48KiB) | cortex rebuild, webhook receivers | P0 |
| Public webhook entry | `https://{ref}.supabase.co/functions/v1/{name}`; `verify_jwt` toggle | KICK/GitHub/QStash receivers | P0 |
| Schedules | NO cron endpoint in Mgmt API — use pg_cron + pg_net → function | heartbeats, eval runs | P0 |
| Realtime | Broadcast/Presence/PG-changes; **Broadcast REST push** `POST /realtime/v1/api/broadcast/{topic}/events/{event}`; free: 200 conns, 100 msg/s, 256KB, 2M msgs/mo, replay 72h | panel live tiles (no polling) | P0/P1 |
| Operator auth | Passkeys (WebAuthn), email OTP, anonymous+linking | panel v2 login | P0 |
| OAuth 2.1 Server (beta) | project = IdP: authorize/token/JWKS/OIDC discovery, PKCE, dynamic client registration | "Sign in with NEXUS" for bot tooling/MCP | P1 |
| Auth Hooks | Before-User-Created, Custom Access Token, Send Email/SMS (free tier) | custom claims (bot vs operator) → RLS | P1 |
| Backups | `GET /database/backups`, restore endpoints; **no auto-backup on free** | manual export discipline + Blob offsite | P0 |
| Logs | `GET /analytics/endpoints/logs*`; **1-day retention free** | panel tiles treat as ephemeral; ship hot logs to Redis | P0 |
| pgvector | free tier OK; HNSW; vector ≤2000 dims | brain memory (needs embedder) | P1 |
| Limits | 500MB DB · 2 active projects · 5GB egress · 1GB storage · 500K fn invocations/mo · 150s fn wall clock · **pause after ~1 week low user DB activity** | anti-pause heartbeat (QStash→fn→PostgREST write) | constraint |

---

## 4. Upstash family (all [MEASURED] from docs/pricing, 2026-10-23)

| Product | Free tier | NEXUS use | Verdict |
|---|---|---|---|
| Redis | 250MB · **500K cmds/MONTH** · 10GB bw · 10K cmd/s | @upstash/ratelimit on public endpoints, hot counters, dedupe, short buffers. NOT the high-frequency event spine (QStash push is cheaper) | **USE NOW** |
| QStash | 1,000 msgs/day · 1MB · 10 schedules · 10 queues · DLQ 3d · retries count as messages | schedules (cron), retries, fan-out → **Edge Function receiver** (public URL required [MEASURED]) · QStash dev server for sandbox parity | **USE NOW** |
| Workflow | 1,000 steps/day · needs public endpoint · no Deno support | durable RSI loops — blocked until public host or paid Box keep-alive | **LATER** |
| Vector | 10K queries + 10K updates/day · dim ≤1536 · 100 namespaces · 1GB | brain semantic memory; auto-embed hosted model = `openai/text-embedding-3-small` (bge-* discontinued for new indexes) | **USE NOW** |
| Box | 10 boxes · 2 vCPU/4GB/10GB · **5 CPU-hr/mo** · idle 1h → pause (0 CPU) · $1/mo LLM (openrouter/free) · cron + git module | burst runner: nightly clone+eval+PR, short scrape jobs. NEVER a host | **USE NOW (burst only)** |
| Blob | 1GB · 10K simple + 2K advanced ops/mo · 10GB egress · signed 10-min URLs · rclone-compatible | nightly age-encrypted backups (30/mo ≪ 2K ops) | **USE NOW** |

**Key pipelines:** (a) QStash → Edge Function (`Upstash-Signature` verified) → Postgres + Redis → panel; (b) Vector namespaces `episodes`/`facts`/`docs`; (c) Blob nightly encrypted dump + manifest row in Postgres; (d) Box cron "clone NEXUSbot → run evals → open PR".

---

## 5. External data stack

| Service | Facts [MEASURED unless noted] | Verdict |
|---|---|---|
| **Bright Data** | API token + zones; Unlocker 1cr/req, SERP 1cr/req, Scrapers 1cr/record, Browser 5cr/MB; **proxies NOT covered**; 5,000 cr/mo renew 1st; unfunded → hard stop + 1,000 req/min | **USE NOW** — SERP + Web Unlocker only; Hyperbrowser stays the single browser pool |
| **Exa** | `api.exa.ai` `/search` `/contents` `/answer`; `x-api-key`; Lite $4/1k, contents $1/1k pages, answer $5/1k; balance $28.74 | **USE NOW** — brain research tool (depth) over the free sandbox web_search (breadth) |
| **Nebius** | VMs/GPU/Object Storage/Devlabs; no meaningful free tier; $119 balance | **PARK** — revisit only if self-hosted vLLM beats Vyce/Groq on cost |
| **Hyperbrowser** | sessions/stealth/CAPTCHA/profiles/agents/MCP; **per-session custom proxy = PAID feature** → Webshare egress blocked on free tier; free 5,000cr, 1 concurrent session | **USE NOW** as L1 browser pool; Startup $30/mo only when Webshare-per-session egress is needed |
| **KICK** | Official: dev.kick.com, OAuth 2.1 `id.kick.com` (client-credentials + auth-code PKCE), `api.kick.com/public/v1` (chat write, channel read/write, `events:subscribe` webhooks). Prior-art [MEASURED]: `kick.com/api/v2/channels/{slug}`, Pusher WS for chat | **USE NOW (L1/L2)** — official API first; Pusher WS read-only fallback |

---

## 6. Durability (solved this round)

**Incident:** rounds 1–10 lost; sandbox boots from `/home/sync/repo.tar` written at pre-stop; this session had no tar (fresh boot) → upload/ mount + git initial commit only. [MEASURED]

**Solution shipped (commit 183a4b2):**
- `.zscripts/dev.sh` — boot-time dev entry (auto-started by `/start.sh` on every future boot) + `ensure-dev.sh` per-turn guard.
- `scripts/secret-scan.sh` — fail-closed battery over the sanitized set; any hit aborts the push.
- `scripts/snapshot-backup.sh` — orphan squash-snapshot chain (`public-snapshot` → remote `main`): temp-index plumbing (no worktree switch), excludes `upload/`, `download/`, PNGs; never force-pushes; askpass keeps the token out of argv/config.
- Serverless device-flow bootstrap in `GET /api/backup/status` (the panel's 30s poll drives mint → poll → authorize → backup; no background process needed — the harness reaps user processes between tool calls) + live Durability tile.
- **Secret audit result:** 6 real-looking Webshare proxy credentials in 4 tracked upload/ files (excluded from public snapshot by design; owner should rotate). Zero GitHub tokens/JWT/service keys anywhere else. 2 PNGs excluded pending eyeball.
- Offsite redundancy (pending owner default-yes): weekly age-encrypted git bundle → Upstash Blob private bucket.

**Residual risks [INFERRED]:** pre-stop tar write can fail on abnormal shutdown (the likely cause of the round 1–10 loss) — the GitHub remote is the real fix; worklog/STATE are public-safe by P7 discipline.

---

## 7. Roadmap (proposed; gates per directive §3)

| Phase | Content | Gate |
|---|---|---|
| **R11 (this round)** | reset recovery, grounding research, durability system, control-plane scaffold | owner reads this doc |
| **R12 — Walking skeleton** | Supabase schema bootstrap via PAT (L0 events table + spend ledger + rsi_config), one Edge Function webhook (KICK chat event) → Postgres → Realtime broadcast → panel live tile; QStash daily heartbeat (anti-pause) | G2 spec + G4 plan |
| **R13 — Panel v2 rebuild** | vault (AES-GCM) re-entry UI: vyce, groq, supabase PAT, upstash (redis/qstash/vector/blob), hyperbrowser, webshare, brightdata, exa · connector health tiles · passkey operator auth (Supabase) | G5 verify |
| **R14 — Brain online** | model router (T0–T5) with drift detection + spend ledger · Vyce live-probe matrix · memory: Upstash Vector namespaces · Exa/Bright Data research tools | G5 verify |
| **R15 — Bot rewire (stream integration)** | KICK official OAuth app (owner creates client at dev.kick.com) · chat send via official API · cortex v30 lineage (evidence-gated RSI, cross-family judge, Webshare egress) redeployed as managed Edge Functions · Box nightly eval | G5 verify |
| **R16 — L4 improvement loop** | frozen eval set + paired promotion + one-command rollback (directive §5A) | G6 release |

---

## 8. Decision gates for the owner (D = decide; defaults let work continue)

| # | Decision | Recommended default |
|---|---|---|
| **D1** | Approve device flow (enter code at github.com/login/device — see panel tile) to activate the public backup | approve — it is the durability fix |
| **D2** | Public snapshot policy: squash-snapshot chain, upload/+PNGs excluded, no force push | yes (as shipped) |
| **D3** | Brain roster: T0–T5 table in §2.3 + spend alerts 50/80/95% | approve; adjustments cheap later |
| **D4** | Memory backend: Upstash Vector auto-embed (feature-flagged) over SQLite-only | approve |
| **D5** | Supabase: WebGUI_HARNESS = runtime substrate, gspp = staging/eval twin; heartbeat both | approve |
| **D6** | Webshare: rotate the 6 exposed proxy passwords (burned in tracked docs; redacted from public by exclusion) | rotate at next Webshare login |
| **D7** | KICK official API app (owner creates OAuth client at dev.kick.com when we reach R15) | create then |

**Open technical questions carried forward:** Vyce silent-fallback probe (needs key) · Groq limits re-verify (needs key) · Workflow-on-Deno spike (deferred) · pgvector vs Vector revisit trigger (>1M vectors or SQL-joined memory).

---

## 9. Sources (primary, dated 2026-10-23 unless noted)

Vyce: vyceai.com shipped bundle `assets/index-B8PAScdk.js` (fetched), unauth probes → 401 OpenAI-shaped errors · lmspeed.net audit 2026-08-17. Groq: console.groq.com docs sections + third-party trackers (sim.ai, deadcanary 2026-08) — console 403-blocked from sandbox [MEASURED]. Supabase: `supabase.com/openapi.json` (115 paths), `/docs/guides/**` + `pricing.md` via llms.txt index. Upstash: `upstash.com/docs/llms.txt` (~1,500 pages), machine-readable `upstash.com/pricing/<product>.md`. Bright Data: docs.brightdata.com. Exa: exa.ai/docs + llms.txt. Hyperbrowser: docs.hyperbrowser.ai. GitHub: docs.github.com device-flow + repo-create scope text. KICK: dev.kick.com / api.kick.com swagger. Platform: `/start.sh` (repo.tar boot mechanics), local probes.
