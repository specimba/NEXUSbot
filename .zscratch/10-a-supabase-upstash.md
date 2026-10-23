# 10-a — Supabase + Upstash Deep-Dive (pre-brain research)

Agent: research-agent (Supabase/Upstash) · 2026-10-22 · Task ID 10-a
Scope: capability survey + exact API surfaces BEFORE programming the LLM brain.
Protocol: [MEASURED] = probed/fetched live from sandbox; [INFERRED] = from docs/memory.
P7 honored: no real credential values anywhere; all probes used fake tokens; only unauthenticated/
fake-cred GET/POST probes against public endpoints; no remote resource created or modified.

Projects under study (both refs live [MEASURED]):
- NEXUS_WebGUI_HARNESS ref=`vwottesqbdgcsmvvvzok` (ap-south-1) — `https://vwottesqbdgcsmvvvzok.supabase.co`
- nexus-gspp ref=`thgvcrwejojlwcjpsgsu` (eu-west-1) — `https://thgvcrwejojlwcjpsgsu.supabase.co`

---

## PART A — SUPABASE

### A1. SQL-over-PAT control plane (the big unlock) — P0, effort S
Purpose: run arbitrary SQL against a project using ONLY the Management PAT stored in the
panel vault. No DB password, no connection string, no PostgREST key needed.

API surface [MEASURED doc + endpoint probe]:
- `POST https://api.supabase.com/v1/projects/{ref}/database/query`
- Auth: `Authorization: Bearer sbp_...` (Management PAT, fine-grained scope `database:write` or
  `database_read`; legacy PAT = full user privileges)
- Body JSON: `{"query": "select ...", "parameters": [<any>], "read_only": false}`
  - `parameters` = positional $n params array (safe templating for the brain)
  - `read_only: true` forces read-only execution (use for brain SELECTs)
  - Read-only sibling endpoint: `POST /v1/projects/{ref}/database/query/read-only` (runs as
    `supabase_read_only_user`) [MEASURED doc]
- Success: `201` with JSON array of row objects. Errors: 401/403/429/500.
- curl example:
  ```
  curl -X POST https://api.supabase.com/v1/projects/vwottesqbdgcsmvvvzok/database/query \
    -H "Authorization: Bearer sbp_xxx" -H "Content-Type: application/json" \
    -d '{"query":"select id, created_at from events order by created_at desc limit 5","read_only":true}'
  ```
- Error shape [MEASURED with fake PAT]: `401 {"message":"JWT could not be decoded"}`
- Rate limits [MEASURED doc]: 120 req/min per user+project+endpoint; `GET /v1/projects/{ref}/database/context`
  is 10/min (+1/sec burst); migrations endpoint has 3-min timeout at 120/min.
- Status: experimental/Beta per docs — subject to change [INFERRED risk].

NEXUSbot mapping: brain config-plane. Create/alter tables, seed RLS policies, inspect schema
(`information_schema`), backfill data — all from the panel brain with only the PAT in the vault.
Vault contract: store ONE secret (`supabase` / `mgmt-pat`); both projects reachable with same PAT.
Risk: PAT = full-account control → scoped PAT + vault-only + never log; Beta endpoint drift.
Mitigation: wrap in `src/lib/connectors/supabase-mgmt.ts` with read_only default true.

### A2. Edge Functions via Management API (deploy + invoke) — P1, effort M
API surface [MEASURED doc + probe]:
- Deploy: `POST https://api.supabase.com/v1/projects/{ref}/functions/deploy`
  - `Authorization: Bearer sbp_...` (scope `edge_functions:write`, permission `edge_functions_write`)
  - multipart/form-data: `file` = array of source files, `metadata` = JSON object
    ({entrypoint_path, name, verify_jwt, import_map, import_map_path}); query params `slug`, `bundleOnly`
  - `201` → `{id, slug, name, status:"ACTIVE", verify_jwt, import_map, entrypoint_path, ezbr_sha256}`
  - 402 exists on this endpoint = billing/plan gate [MEASURED doc]
- List/Get/Delete: `GET|DELETE /v1/projects/{ref}/functions[/{slug}]`; create shell `POST /v1/projects/{ref}/functions`
- Invoke (data plane): `POST https://<ref>.supabase.co/functions/v1/<slug>` with `Authorization: Bearer
  <publishable|secret|anon|service key>` when `verify_jwt=on`; `verify_jwt=false` = open endpoint.
  [MEASURED probe: unknown slug → `404 {"code":"NOT_FOUND","message":"Requested function was not found"}`]
- Secrets for functions: `PATCH /v1/projects/{ref}/secrets` (doc-known path) [INFERRED].

Free tier: 500K edge function invocations/month included, then $2 per 1M [MEASURED snippet from
billing docs]. 2 projects max on free plan.
NEXUSbot mapping: (1) webhook receiver for QStash callbacks when panel isn't publicly reachable;
(2) cron-style brain jobs; (3) zero-infra glue between GitHub webhooks and NEXUS L0 stream. Edge fn
can call back to panel ingest token bearer.
Risk: deploy-by-PAT = code supply surface; keep function source in git, deploy only via panel action.
Escape hatch: functions are Deno/TS — Bun-compatible source mostly.

### A3. Realtime (broadcast / presence / RLS) — P1, effort S
API surface [MEASURED doc + probes]:
- WebSocket: `wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<key>` (Phoenix channel protocol v2).
- HTTP broadcast (server push, no WS needed):
  `POST https://<ref>.supabase.co/realtime/v1/api/broadcast`
  headers: `apikey: <publishable/secret key>`, `Content-Type: application/json`
  body: `{"messages":[{"topic":"room:1","event":"nexus.event","payload":{...},"private":true}]}`
  [MEASURED 401 shapes: no apikey → `{"message":"No API key found in request",...}`; fake key →
  `{"message":"Invalid API key","hint":"Double check your Supabase anon or service_role API key."}`]
- Private channels: clients must authenticate; RLS enforced by Realtime inserting+reading then
  rolling back a probe message [MEASURED doc].
- From-DB broadcast: `select realtime.send(payload jsonb, event text, topic text, private bool)`
  and `realtime.send_binary(bytea)`; `realtime.broadcast_changes()` triggers. DB broadcasts stored in
  `realtime.messages`, deleted after 3 days [MEASURED doc].
- Key migration: anon/service_role deprecated end-2026 → `sb_publishable_xxx` / `sb_secret_xxx` [MEASURED doc].
Free tier: 200 concurrent Realtime clients [MEASURED snippet, schematichq 2026].
NEXUSbot mapping: L0 push channel — panel Stream tab could subscribe directly to a private channel
instead of 2s polling; brain→owner instant alerts via HTTP broadcast from anywhere (Box, Edge Fn).
Risk: RLS misconfig on private channels; 3-day retention only for DB-sourced messages.

### A4. OAuth 2.1 Server (Beta) — P2, effort M
API surface [MEASURED — live discovery doc on harness project]:
- `GET https://vwottesqbdgcsmvvvzok.supabase.co/auth/v1/.well-known/openid-configuration` → `200`
  with: authorization_endpoint `/auth/v1/oauth/authorize`, token_endpoint `/auth/v1/oauth/token`,
  jwks_uri `/auth/v1/.well-known/jwks.json`, userinfo `/auth/v1/oauth/userinfo`;
  scopes `openid profile email phone offline_access`; grants `authorization_code, refresh_token`;
  response `code` (query mode); PKCE `S256, plain`; client auth `client_secret_basic|client_secret_post|none`;
  signing `RS256|HS256|ES256`. Discovery also at `/.well-known/oauth-authorization-server/auth/v1`.
- Enable: Dashboard → Authentication → OAuth Server; authorization UI must be built by us at
  SiteURL+configured path with `authorization_id` handled via supabase-js
  `auth.oauth.getAuthorizationDetails/approveAuthorization/denyAuthorization` [MEASURED doc].
- Client registration via dashboard/Management API [INFERRED path].
- OIDC ID tokens REQUIRE asymmetric keys (RS256/ES256) — HS256 fails ID token generation [MEASURED doc].
Free tier: beta on ALL plans, no extra charge; users count toward MAU (50K free) [MEASURED doc].
NEXUSbot mapping: NEXUS OS as identity provider — NEXUSbot sessions, third-party agent clients,
GitHub-App-like delegation later. Not needed for brain v1.
Risk: beta drift; consent UI work; key migration HS256→RS256.

### A5. Passkeys / WebAuthn (experimental) — P2, effort S
API surface [MEASURED doc]:
- Enable via Management API:
  `PATCH /v1/projects/{ref}/config/auth` body `{"passkey_enabled":true,"webauthn_rp_display_name":"NEXUS OS",
  "webauthn_rp_id":"<bare domain>","webauthn_rp_origins":"https://a,https://b"}` (≤5 origins, hostname must
  match/subdomain of RP ID; HTTPS required; changing RP ID invalidates all passkeys).
- Client: supabase-js ≥ v2.105.0 with `auth:{experimental:{passkey:true}}`;
  `auth.registerPasskey()`, `auth.signInWithPasskey()` (discoverable credentials — no identifier needed),
  low-level `auth.passkey.{startRegistration,verifyRegistration,startAuthentication,verifyAuthentication,list,update,delete}`.
- Admin: server-side list/revoke via secret key [MEASURED doc].
Free tier: free (auth MAU covers it).
NEXUSbot mapping: panel login hardening (replace/augment PANEL_PASSWORD cookie later); brain-driven
user accounts on gspp project. Not brain-critical.
Risk: experimental API; RP-ID lock-in.

### A6. Auth Hooks — P2, effort M
API surface [MEASURED doc]:
- Hook types & plans: Before User Created (Free), Custom Access Token (Free), Send SMS (Free),
  Send Email (Free), MFA Verification Attempt (Teams+), Password Verification Attempt (Teams+).
- Config: SQL hook `uri = "pg-functions://postgres/<schema>/<fn_name>"` (Postgres function taking
  `event jsonb` → `jsonb`, granted to `supabase_auth_admin`, revoked from anon/authenticated/public)
  or HTTP endpoint with signed payload (HMAC-SHA256 signature header + secret, versioned `v1`).
- Runtime errors: return `{"error": {...}, "msg": "..."}` JSON.
NEXUSbot mapping: `custom_access_token` hook = inject NEXUS role/agent claims into JWTs → RLS sees
agent identity (critical later for L1/L2 multi-agent authz). Effort M because RLS + grants must be tested.
Risk: hook bug = broken auth flows; keep hook minimal, versioned migration.

### A7. Logs / Analytics endpoints — P1, effort S
API surface [MEASURED changelog 2026-07-23]:
- NEW: `GET /v1/projects/{ref}/analytics/endpoints/logs` — ClickHouse SQL only, unified `logs` table,
  filter `WHERE source_name='edge_logs'|'postgres_logs'|'auth_logs'|...`; nested fields via
  `log_attributes['request.method']` map. OLD `.../logs.all` REMOVED 2026-09-23.
- Rate limit: 30 req/min on analytics log endpoints [MEASURED intro page].
- Auth: same PAT Bearer.
NEXUSbot mapping: brain observability — pull edge fn logs, auth failures, DB errors into eval loop
(RSI feedback), all with the same PAT. Effort S (single client wrapper shares A1 infra).

---

## PART B — UPSTASH

Account context: Redis already connected, ping 171ms [owner-measured, pre-reset]. Console API key
regeneration required after reset (owner action).

### B1. QStash (HTTP message queues + schedules + callbacks) — P0, effort M
API surface [MEASURED docs + live probes]:
- Hosts: `https://qstash.upstash.io` (global) or regional `https://qstash-{region}.upstash.io`
  (`us-east-1`, `eu-central-1`) [MEASURED OpenAPI]. Auth: `Authorization: Bearer <QSTASH_TOKEN>`
  (query-param bearer also supported per OpenAPI security).
- Publish: `POST /v2/publish/{url|urlGroup}` — JSON body up to free 1 MB; forwarded headers
  `Upstash-Forward-<Name>: value`; `Upstash-Delay: 5m`; `Upstash-Retries: 3`; `Upstash-Not-Before: <epoch>`;
  dedup `Upstash-Deduplication-Id`; `Upstash-Callback` + `Upstash-Failure` URLs get the destination
  response (callbacks are billed as messages).
- FIFO: `POST /v2/enqueue/{queueName}/{url}`; queues CRUD `/v2/queues[/{name}]` (pause/resume).
- Batch: `POST /v2/batch` JSON array of message objects.
- Schedules: `POST /v2/schedules/{destination}` + `Upstash-Cron: "0 0 * * *"` (5-field, UTC);
  GET/DELETE `/v2/schedules[/{id}]`, pause/resume per schedule.
- DLQ: `/v2/dlq` list/get/retry/delete (RPS-limited observability APIs). Logs: `/v2/logs` (paginated).
- Signing keys: `GET /v2/signing-keys`; inbound delivery carries JWT in `Upstash-Signature`
  (HMAC-SHA256 with signing key) — verify with `Receiver` from `@upstash/qstash`.
- Error shape [MEASURED, fake token]: `401 {"error":"unable to authenticate: invalid token"}` on
  /v2/publish, /v2/schedules, /v2/dlq.
- Oversize body → HTTP 412 [MEASURED pricing FAQ].
SDK: `@upstash/qstash` (TS), `qstash` (Python). No RPS limit on delivery APIs; max parallelism 10 (free).

Free tier [MEASURED pricing page]: 1,000 messages/day · 50 GB bw/mo · 1 MB msg size · 1 URL group ·
100 endpoints/group · max delay 7 days · 3 days DLQ+logs retention · 10 active schedules · 10 queues ·
queue parallelism 2 · parallelism 10. Soft limits — consistent overage → contact/429.
NEXUSbot mapping:
- L0 event durability: panel posts brain-worthy events as QStash messages to the panel's own
  `/api/events` ingest (bearer token) → at-least-once + retries, DLQ visible in panel.
- Brain job queue: `/v2/enqueue/brain-jobs/...` FIFO for serialized agent actions.
- RSI eval scheduling: `/v2/schedules` cron → eval endpoint (10 free schedules).
- Long tasks: `Upstash-Callback` pattern instead of holding SSE.
Risk: every retry = 1 billed message (watch 1k/day on free); public HTTPS destination required for
panel routes (sandbox :3000 not public — needs tunnel or Edge-Function destination).
Mitigation: Upstash-Callback failures route to DLQ; verify Upstash-Signature in panel.

### B2. QStash Workflow (durable agent runs) — P0, effort M
Surface [MEASURED docs]:
- Built on QStash. Define a workflow endpoint in the panel (Next.js route handler) using
  `serve()` from `@upstash/workflow` (JS) or `workflow-py`. Steps each execute in separate HTTP calls;
  results stored durably; failed step retried individually; completed steps skipped on resume.
- Trigger REST: `POST https://qstash.upstash.io/v2/trigger/{workflowUrl}` with
  `Upstash-Workflow-RunId`, `Upstash-Forward-*`, `Upstash-Retries`, `Upstash-Delay`, `Upstash-Not-Before`;
  batch trigger endpoint exists. Runs API: cancel, retry-step-now, logs list. DLQ: restart/resume
  (resume continues from failed step) + failure callbacks.
- Events: `context.waitForEvent` + notify endpoints (notify-event, list-waiters) for human-in-loop.
- Primitives: `context.sleep/sleepUntil` (months), `context.call` (Upstash performs slow HTTP call),
  parallel steps via `Promise.all`, flow control (rate/parallelism), auth via same QStash token;
  signature verification for the workflow endpoint [MEASURED security doc].
Free tier: shares QStash free 1,000 msgs/day (each step = HTTP call = QStash message) [INFERRED mechanics].
NEXUSbot mapping: THE brain runner — RSI loop as workflow: eval step → `waitForEvent` owner approval →
patch step → report step. Long memory consolidation as nightly workflow with sleeps.
Blocker/risk: workflow endpoint must be publicly reachable (docs explicit: serverless target or
tunnel). Local dev: dev-mode tooling exists per changelog [INFERRED] — verify at build time.

### B3. Vector (serverless vector DB) — P0, effort S
Surface [MEASURED docs + pricing]:
- Host: `https://<index-url>.upstash.io` per-index URL from console; Auth `Authorization: Bearer
  <UPSTASH_VECTOR_REST_TOKEN>`. Success `{result:...}`; failure `{"error":"Unauthorized: Invalid auth token","status":401}` [MEASURED doc].
- Endpoints: `POST /upsert` body `{"id","vector":[...],"data":"<raw text>","metadata":{},"namespace"}`;
  `POST /query` body `{"vector"|"data", "topK"(default ≤1000), "filter", "includeMetadata", "includeData",
  "namespace"}`; `/fetch`, `/range`, `/delete`, `/delete-metadata`, `/list-namespaces`, `/info`, `/reset`.
- KEY: if the index is created with an embedding model, you upsert raw TEXT via `data` and Upstash
  embeds server-side (also query by text) — no external embeddings endpoint needed. This replaces our
  missing embeddings provider [MEASURED doc concept].
- SDKs: `@upstash/vector` (TS), `upstash-vector` (py), Go; REST.
- Metadata filtering + namespaces supported; sparse vectors "coming soon" [MEASURED pricing].
Free tier [MEASURED pricing page]: 10K query+update ops/day · 200M vectors×dims cap · 1,536 max dims ·
100 namespaces · 48 KB metadata/vector · 1 MB data/vector · 1 GB total data · up to 10 free indexes ·
regions: N. Virginia, AWS Ireland, AWS Iowa, GCP. PAYG $0.40/100K req, $0.25/GB storage.
NEXUSbot mapping: long-term memory (namespace per event-source or per day), RSI eval precedent search
(query past evals by text), doc KB for brain prompts. Region eu-west-1 alignment possible via AWS Ireland.
Risk: 10K ops/day free cap (batch upserts ≤100/batch to stretch); embedding model is fixed per index
at creation — pick the biggest needed dim (≤1536 free).

### B4. Blob (object storage) — P1, effort S
Surface [MEASURED docs + machine-readable pricing]:
- S3-compatible. SDK `@upstash/blob` — `Bucket.fromEnv()` with `UPSTASH_BLOB_TOKEN`; public bucket =
  public URLs; private bucket = time-limited signed read URLs; `put/get/info/exists/list/copy/move/delete`;
  signed upload URLs; browser upload handler + `useUpload` React hooks; multipart above 100 MB;
  conditional writes; metadata; max object 5 TB. Also connectable via ANY standard S3 client
  (`bucket/connecting` docs) [MEASURED doc].
- Global bucket (no region; CDN-replicated). 401-before-auth and 5xx requests not billed.
Free tier [MEASURED]: 1 GB storage · 10K simple ops/mo · 2K advanced ops/mo · 10 GB egress/mo; hard-stop
when exceeded (never charged). PAYG $0.02/GB, $0.30/1M simple, $4.50/1M advanced, 1 TB egress free.
NEXUSbot mapping: artifacts store — screenshots, eval reports, Box workspace exports, G5 userscript
bundles; private bucket + signed URLs fits panel download flow.
Risk: 2K advanced ops/mo free is small — batch exports, avoid churning small files.

### B5. Box (NEXUSbotBOX1: persistent compute + agent) — P0/P1, effort M
Surface [MEASURED docs + machine pricing]:
- SDK `@upstash/box` (npm) / `upstash-box` (pip); auth `UPSTASH_BOX_API_KEY = box_...` (console API key).
- Create: `Box.create({runtime:"node"|"python"|"golang"|"ruby"|"rust" (+`-alpine`), keepAlive?:bool,
  initCommand?:string, agent?:{model, apiKey?}, networkPolicy?, attachHeaders?, timeout?})`.
  `initCommand` runs on create/resume/snapshot-restore (place to start long-lived services).
- Capabilities per box [MEASURED]: Agent (Claude Code, Codex, OpenCode, Cursor, custom harness; model
  via Upstash-provided e.g. `openrouter/openrouter/free` or BYOK) · Shell (SDK `box.shell` exec,
  10-min default wait, or SSH `ssh <box-id>@us-east-1.box.upstash.com` password=Box API key, or account
  SSH keys ≤20, ed25519/ECDSA/RSA≥2048) · Filesystem (upload/write/read/list/download) · Git (clone,
  diffs, PRs) · Snapshots (`box.snapshot({name})` → restore; captures filesystem+agent-model+runtime+
  browser setting; NOT agent key/network policy/init/schedules) · Schedules (`box.schedule.exec({cron,
  command[]|agent prompt, webhookUrl?, webhookHeaders?, folder?})` — 5-field cron UTC) · Browser
  (managed Chromium: tabs/reading pages/AI actions/recordings/live view/`Connect over CDP` — Playwright
  attach) · Public preview URLs · Live sessions · Ephemeral boxes · Network policy (deny-all egress
  option) · Keep-alive (paid).
Free tier [MEASURED /pricing/box.md]: 10 concurrent boxes · 5 CPU-hours/month · $1 LLM budget/month
(overage → HTTP 400 from agent API; BYOK bypasses) · Small = 2 vCPU / 4 GB / 10 GB disk — matches
NEXUSbotBOX1 exactly · AWS us-east-1 today · standard boxes auto-pause when idle (no CPU charge;
processes stopped, state preserved; wakes on next request) · storage $0.10/GB/mo incl. snapshots (PAYG).
Keep-alive Small = $8/mo. PAYG boxes $0.1–0.4 per ACTIVE CPU-hour.
NEXUSbot mapping:
- Browser-task offload: Box browser for scraping/verification runs (CDP), complements Hyperbrowser.
- Scheduled agent jobs: `box.schedule.exec` cron prompts (uses the $1/mo LLM budget on free).
- Long-term agent workspace: workspace + snapshots as checkpoint before risky changes (RSI).
- Shell from panel brain: SDK call per user action; 10-min wait fits panel request model.
Risk: 5 CPU-h/mo free is ~16 min/day of full-2-core burn — schedule tightly, snapshot after setup;
idle auto-pause kills running processes (initCommand re-runs on wake); us-east-1 latency from panel.
Box free LLM budget expiry → 400s; switch agent to BYOK via panel vault if needed.

### B6. Upstash Developer/Account API (ops glue) — P2, effort S
Surface [MEASURED doc index]: `https://api.upstash.com/v2` — Basic auth (account email + console API
key): list/create/delete Redis DBs, QStash user/plan/stats/token reset, vector index stats, audit logs,
teams. NEXUSbot mapping: panel "Connectors" could show real quota usage (QStash stats endpoint) without
scraping console. Risk: account-wide key = broad power; store in vault, read-only usage.

---

## TOP-10 PRIORITIZED INTEGRATION ROADMAP (brain-ready order)

1. P0 · S — **Vault re-entry set + Supabase Mgmt client** (`supabase-mgmt.ts`): one PAT, both refs;
   `POST /v1/projects/{ref}/database/query` wrapper w/ `read_only` default true, 429-aware (120/min).
2. P0 · S — **Upstash Vector long-term memory**: create free index (embedding model, ≤1536 dims,
   AWS Ireland for gspp alignment); `data`-text upsert/query = replaces missing embeddings endpoint.
3. P0 · M — **QStash L0 durability lane**: panel `POST /api/events` events mirrored to QStash FIFO
   `brain-jobs`; verify `Upstash-Signature`; DLQ list visible in panel.
4. P0 · M — **QStash Workflow brain runner**: workflow endpoint in panel (route handler + `serve()`),
   RSI eval loop with `waitForEvent` owner gate; requires public URL → tunnel (dev) or deploy.
5. P1 · S — **QStash schedules for RSI evals**: `POST /v2/schedules/<panel>/...` cron (≤10 free);
   daily eval + nightly memory consolidation.
6. P1 · M — **Supabase Edge Functions**: deploy `nexus-events-bridge` via `functions/deploy` (multipart)
   as public webhook receiver (GitHub/agent callbacks) → forwards to panel ingest with bearer.
7. P1 · S — **Logs endpoint observability**: `GET /v1/projects/{ref}/analytics/endpoints/logs`
   (ClickHouse SQL, `source_name` filter) → brain eval feedback (edge fn + auth + postgres errors).
8. P1 · S — **Blob artifacts**: private bucket for eval reports/screenshots/exports; signed URLs in panel.
9. P1 · M — **Box offload**: NEXUSbotBOX1 browser tasks (CDP/Playwright) + `box.schedule.exec` agent
   crons; snapshot after workspace setup; watch 5 CPU-h + $1 LLM free caps.
10. P2 · M — **Panel hardening/identity layer**: Realtime private-channel push replacing Stream polling;
    then Passkeys for panel login, Auth Hooks custom-claims, OAuth 2.1 Server as NEXUS IdP (beta, gate).

Sequencing logic: 1–3 unblock the brain's hands (config plane, memory, durable stream) with ZERO new
infrastructure decisions; 4–7 give the brain autonomy under owner gates; 8–9 give it senses/tools;
10 is identity, deferred behind owner's beta appetite.
