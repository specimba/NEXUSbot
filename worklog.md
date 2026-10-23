# NEXUS_BOT / NEXUS OS — Worklog

Shared, append-only. Each entry starts with `---`, includes Task ID / Agent / Task /
Work Log / Stage Summary. Read before working; append after finishing.

---
Task ID: 7-0
Agent: orchestrator (main)
Task: Rebuild core after sandbox cold-reset; fix hydration + missing panel password; restore durable env; prep wave-2.

Work Log:
- Fact check: git = 1 commit (Initial), src = scaffold only, .env = DATABASE_URL-only, no panel code. Previous session's reported work (7 commits) did not survive; only upload/ (mount point) remained. Reported honestly to owner.
- Root cause [VERIFIED]: /start.sh restores from /home/sync/repo.tar and rewrites .env to DATABASE_URL-only on cold boot.
- Rebuilt core: prisma schema (Event/Credential/IngestToken/Setting) + db:push; src/lib/crypto.ts (AES-256-GCM vault, v1 envelope, VaultIntegrityError, ENCRYPTION_KEYS_PREV); src/lib/auth.ts (PANEL_PASSWORD, HMAC cookie sessions, requireSession); src/lib/guard.ts (rate limit).
- API: /api/auth/{login,logout,session}, /api/events (GET+POST, bearer ingest), /api/stats, /api/ingest-tokens (+[id] DELETE), /api/credentials (+[id] DELETE, masked), /api/settings (whitelisted budgets).
- UI: providers (next-themes dark default + TanStack Query), layout (suppressHydrationWarning on html AND body — Grammarly fix), globals.css (dark matrix×fallout×cyberpunk oklch tokens + grid/scanlines/glow; light neutral Apple), page → PanelApp (gate → shell), tabs: Overview/Stream/Connectors/Settings/Eval(G6-locked), ingest token manager (show-once), sticky footer, 44px targets, honest empty states.
- Durability: scripts/ensure-env.sh + rotate-panel-password.sh (values never echoed); .zscripts/dev.sh now runs ensure-env at boot (survives future resets); restored AGENTS.md from upload/; .env.example names-only.
- Ops discovery: tool-spawned servers are reaped cross-call unless pid is recorded in .zscripts/dev.pid (blessed mechanism). Dev server restored + recorded.
- Verification: bun run lint CLEAN; tests/verify-core.sh 18/18 PASS (auth 401s, login, vault roundtrip masked, bearer ingest, token revoke, budgets). No secret values in any output (P7).

Stage Summary:
- Core L0 + panel skeleton + theme + auth + vault live on :3000, 18/18 verified.
- Owner gets password by downloading workspace → .env → PANEL_PASSWORD (runbook §0).
- Wave-2 (7-a Upstash, 7-b Hyperbrowser, 7-c Webshare, 7-d GitHub+Supabase) launching next; connectors.tsx placeholder replaced on integration.

---
Task ID: 7-a
Agent: 7-a (Upstash connector engineer)
Task: T-204 — Upstash REST connector: typed client, status/token API routes, panel card, verify suite.

Work Log:
- Studied existing patterns (events/credentials routes, crypto vault, requireSession, stream.tsx UI tokens); scope kept to the 5 assigned files; connectors.tsx integration left to orchestrator (work record in agent-ctx/7-a-upstash-connector.md).
- src/lib/connectors/upstash.ts: typed REST client — upstashPing (GET /ping, Bearer, 8s AbortSignal timeout, resolves only on {"result":"PONG"}), upstashPipeline (POST /pipeline JSON array, per-command errors in-band, 429/Retry-After honored → typed retryAfterMs), UpstashConnectorError with kind/status/retryAfterMs, fetch-failure sanitize layer (only cause codes like ECONNREFUSED surfaced — url/token can never leak into errors or logs), parseUpstashSecret + https-only validateUpstashUrl.
- status route: requireSession → configured flag; live GET /ping probe per request; VAULT_UNREADABLE / BAD_CONFIG honest error states; token/url never returned.
- token route: PUT {url, token} → non-empty + https validation, JSON-stored via encryptSecret + db.credential.upsert (service "upstash", label "rest"); DELETE idempotent; responses minimal, no echo (P7).
- upstash-card.tsx: self-contained TanStack Query card (key ["connector","upstash","status"], 30s re-probe); NOT CONFIGURED form (url + password token inputs, h-11) / SAVING / CONNECTED health row (mono measured latency + MEASURED badge, refresh, disconnect) / UNHEALTHY typed-error row; skeleton loading, toasts per action, aria labels + role="status", 44px targets, token classes only (no blue/indigo).
- tests/verify-t204.sh: P7-safe — 17 structural checks: unauth 401 ×3, input validation 400 ×2, fake-cred vault roundtrip with echo-leak greps, honest unhealthy probe, delete + configured:false + idempotency.

Stage Summary:
- T-204 code-complete [MEASURED]: verify-t204.sh 17/17 PASS (exit 0); bun run lint CLEAN; dev.log shows only expected 401/400/200 on new routes, no errors.
- Live probe verified end-to-end with fake endpoint (healthy:false + typed sanitized error, no url/token in responses) [MEASURED]. Real-Upstash success path (/ping PONG, /pipeline shapes, 401/429) implemented per REST docs knowledge [INFERRED]/[UNVERIFIED] — no real credentials in sandbox; owner pastes creds via panel and the probe reports truth.
- Integration note for orchestrator: import { UpstashCard } from "@/components/panel/connectors/upstash-card" into the Connectors tab; full API contract in agent-ctx/7-a-upstash-connector.md.

---
Task ID: 7-c
Agent: backend/integration subagent (T-206 Webshare)
Task: Webshare proxy-pool connector — probe-first, routing default OFF; vault-backed token, honest status, connector card, verify suite.

Work Log:
- Read worklog/STATE/runbook/AGENTS/directive (P1–P14, §8, §11) + owner file Webshare30proxiesNEXUSproxyROUTES2110.txt for pool context (30 IPs, authenticated direct proxies). No credential/IP:port values copied anywhere (P7).
- Probed Webshare API v2 from sandbox with fake tokens [MEASURED 2026-10-22]:
  - GET https://proxy.webshare.io/api/v2/proxy/list/ unauth → 401 {"detail":"Authentication credentials were not provided."} (endpoint live, egress OK, RTT ~0.67s).
  - `Authorization: Token <tok>` → 401 "Invalid token." (scheme recognized). `Authorization: Bearer <tok>` → 401 "credentials were not provided" (scheme IGNORED) → client ships the Token scheme, NOT Bearer, despite the task text.
- Built src/lib/connectors/webshare.ts: typed listProxies(token, pageSize=10) with defensive mapping (envelope {count,next,previous,results} [INFERRED from owner apidocs]; fields id/proxy_address/port/username/country_code/valid), 10s timeout, honest failure taxonomy (NETWORK_ERROR/UNAUTHORIZED/FORBIDDEN/RATE_LIMITED/API_ERROR/BAD_RESPONSE). Module never logs; proxy password field never extracted.
- Routes: /api/connectors/webshare/status (requireSession + rateLimit; vault → decrypt transiently → live probe; returns count/validCount/sampled + sample{country,valid} ONLY — no IPs/usernames ever; constant routing:"off"; VaultIntegrityError → honest VAULT_UNREADABLE) and /api/connectors/webshare/token (PUT upsert service="webshare"/label="api", DELETE w/ 404 when absent).
- Card src/components/panel/connectors/webshare-card.tsx: states NOT CONFIGURED (password input + eye toggle + save) / PROBING / CONNECTED (pool summary row, country sample badges, "[MEASURED] live probe" reachability line, accent routing-OFF note "enablement lands with L1 after owner gate", disconnect w/ AlertDialog) / PROBE FAILED (code+message + retry). Toasts, skeletons, aria-live/labels, 44px targets, mono, no blue/indigo.
- tests/verify-t206.sh (P7-safe): 17 PASS / 0 FAIL — unauth 401s ×3, login, 400 short token, PUT fake token 200, status configured:true + apiOk:false (observed code: UNAUTHORIZED — end-to-end real Webshare 401 surfaced honestly) + routing:off, leak greps (no proxyAddress/username/token/IPv4 shapes), DELETE → configured:false, empty DELETE → 404. PANEL_PASSWORD read from .env, never echoed.
- bun run lint CLEAN; tsc --noEmit: no errors outside owner upload/ dir (pre-existing, outside build scope); verify-core.sh re-run 18/18 (no regression); dev.log clean, status probe render ~900ms ≈ real outbound RTT.

Stage Summary:
- T-206 connector ready: token vault-backed, status honest (fake token → apiOk:false UNAUTHORIZED [MEASURED]), routing hard-OFF at the API contract level.
- Unverified without a real token: authenticated result shape + valid/country semantics [INFERRED from owner apidocs]; sandbox egress IP is not on the owner's allowlist, so even a valid token may fail IP authorization — both surface as honest failures, never fake success.
- Orchestrator next: import WebshareCard into connectors tab (connectors.tsx placeholder replacement is outside my file scope).

---
Task ID: 7-b
Agent: connector-builder (T-205 Hyperbrowser)
Task: Hyperbrowser connector — typed REST client + vault-backed key route + honest status route + panel card + P7-safe verify suite.

Work Log:
- Probed real API from sandbox FIRST (honesty requirement):
  [MEASURED] api.hyperbrowser.ai alive (Express); /v1/* paths → 404 HTML ("Cannot GET") — /v1 prefix does NOT exist; app.hyperbrowser.ai/api/health → 401 JSON; official docs (fetched live) name base https://api.hyperbrowser.ai/api + `x-api-key` header.
  [MEASURED] GET /api/sessions (no key / fake key) → 401 {"error":"NOT AUTHENTICATED"}; POST /api/session fake key → 401 JSON; GET /api/session/{id} fake key → 401 JSON. JSON-401 ⇒ route exists + key rejected (unknown routes answer HTML 404).
  [INFERRED] 200 shapes (list {sessions:[…]}, session fields id/status/webdriverEndpoint/viewport/startTime/endTime) — from docs only; not live-verifiable without a real key. Code tolerates absence.
- Built src/lib/connectors/hyperbrowser.ts: config-driven base URL (HYPERBROWSER_BASE_URL, names-only), vault loader (missing/unreadable/key+masked+keyId), typed wrappers (create/list/get session), 8s AbortSignal timeout, typed failure union (network/timeout/http/parse), probeHyperbrowser() discriminating ok vs auth-401 vs other; key NEVER logged/echoed/in error strings.
- Routes: /api/connectors/hyperbrowser/status (requireSession → configured/reachable/apiOk/error + credential masked + probeTarget + sessionsCount; reachable host with rejected key is NOT connected) and /key (PUT vault upsert service "hyperbrowser"/label "default", masked-only response; DELETE idempotent deleteMany). §11 error shape {ok:false,error:{code,message}}.
- Card: components/panel/connectors/hyperbrowser-card.tsx (NOT wired into connectors.tsx — orchestrator integrates). Honest states NOT CONFIGURED → CONNECTED / KEY REJECTED / UNREACHABLE / VAULT ERROR; password input + 44px save/disconnect, toasts, skeletons, aria-live/alert, mono accents, token colors only (no blue/indigo), 30s auto-refresh + manual refresh.
- tests/verify-t205.sh: 3 unauth-401 structural checks; authed login from .env (never echoed); PUT fake key "hb_verify_fake_0123456789" → status must honestly show reachable:true + apiOk:false + non-empty error; P7 no-echo greps on PUT and status responses; DELETE → configured:false. Exit = failure count.

Stage Summary:
- T-205 shipped: 16/16 verify PASS, lint CLEAN, tsc clean on project files, dev.log clean. [MEASURED]
- Card is mounted-ready: import { HyperbrowserCard } from "@/components/panel/connectors/hyperbrowser-card".
- Owner needs a real Hyperbrowser API key pasted via the panel to flip status to CONNECTED (fake-key probe honestly reports KEY REJECTED until then).
- Endpoints /api/session create + list + detail are route-verified via 401 shape; success payloads remain [INFERRED] until a real key exists — defensive typing covers it.

---
Task ID: 10-b
Agent: research-agent (Vyce/Groq)
Task: Research Vyce + Groq API surfaces and produce the NEXUSbot brain model-routing proposal (research only, no source changes).
Work Log:
- Read worklog tail + docs/STATE.md; used scripts/web-search.ts + read-page.ts + unauthenticated curl probes; no keys sent anywhere (P7).
- [MEASURED] Vyce = vyceai.com (apex only; api.vyceai.com NXDOMAIN). GET /v1/models and POST /v1/chat/completions unauth → 401 exact OpenAI envelope {"error":{..."code":"invalid_api_key"},"request_id":...} ⇒ OpenAI-compatible surface confirmed at https://vyceai.com/v1. Docs site is a client-rendered SPA (/docs, /llms.txt return shell) — no crawlable official docs.
- [INFERRED] llm24.net + lmspeed.net corroborate: OpenAI + Anthropic-compatible proxy, 39 models, streaming on all, native tool calling on 8+, vision on Nemotron Vision/MiniMax M3, per-model usage dashboard, USDT billing, health 98.3%. Model IDs match the owner's MEASURED table.
- Groq: sandbox egress is Cloudflare-blocked — api.groq.com/openai/v1/models and console.groq.com/docs/* → 403 {"error":{"message":"Forbidden"}} [MEASURED]; jina reader refused ("bad IP reputation"). Model lineup + free-tier limits taken from 2026 mirrors of official docs [INFERRED]: llama-3.1-8b-instant (128K, $0.05/$0.08, 14,400 RPD free), llama-4-scout (128K, $0.11/$0.34, 30k TPM, vision), gpt-oss-120b ($0.15/$0.60, 1k RPD), llama-3.3-70b ($0.59/$0.79), qwen3-32b, kimi-k2 ($1/$3), groq/compound (agentic), whisper v3/turbo; org-level limits; Developer tier ~10× + 25% off; Batch/caching −50% stackable; x-ratelimit-* headers for backoff.
- Wrote /tmp/r10-research/10-b-model-strategy.md (API surfaces, routing table, cost model, integration blueprint, durability review).
Stage Summary:
- Routing proposal: ROUTER=deepseek-v4-flash-lr ($5.70/mo @10k calls, 380ms) · WORKER=deepseek-v4-flash ($7.04/mo, 2.7s) · FRONTIER=claude-sonnet-4-6 capped ≤10% of calls (~$13/mo blended) · FREE=glm-5.3-flash + Groq free tier ($0.00 plan) · IMAGE=grok-imagine-2 / llama-4-scout vision · BATCH=gpt-6-luna/agnes. gpt-5.6-sol + grok-4.6 excluded (maintenance). Blended recommended plan ≈ $14–16/mo.
- Integration: single fetch-based OpenAI-compatible client, provider registry vyce→https://vyceai.com/v1 / groq→https://api.groq.com/openai/v1, vault-backed keys, model pinning + connect-time GET /v1/models verification (runtime list = source of truth), SSE streaming + strict-JSON zod validation with repair retry, budget counters extended onto the existing /api/settings KV, per-tier fallback chains + circuit breaker (401 never fails over), L0 model_call telemetry. Groq 403 WAF from sandbox must classify as UNREACHABLE_FROM_SANDBOX, not KEY REJECTED.
- Durability review: design sound; adopt immutable daily snapshot-YYYYMMDD tags, pre-push remote-divergence pre-check, ≥30min push throttle, chain-metadata commit messages, gitleaks second opinion, owner-side branch protection (linear history). Nit reported only: secret-scan.sh pattern key typo [uggingface].
- Open items for owner: paste Vyce + Groq keys via panel; G6-eval deepseek-v4-flash-lr for ROUTER; decide Webshare-proxy routing for Groq from sandbox; re-measure the three identical-"380ms" models with a real key.
