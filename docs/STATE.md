# NEXUS OS — STATE

_Last updated: 2026-10-23 (R15 — iframe-proof panel session + .git diet 255M→880K)_

## Status line

- Dev server: **RUNNING** on :3000 (platform-managed via `.zscripts/dev.sh`) [MEASURED]
- backup-cadence mini-service: **RUNNING** on :3011, first run `result=ok` [MEASURED]
- Lint: **CLEAN** · tsc: **CLEAN** · browser golden path: **0 page errors** [MEASURED]
- Public durability repo: **github.com/specimba/NEXUSbot `main` @ `7dcee0d`** — local `public-snapshot` branch matches the remote byte-for-byte (re-measured anonymously in R15) [MEASURED]
- Durability: honestly **DOWN** — backup token lost at boot; auto-resumes on GitHub reconnect (no push lost)
- Private `.git`: **880K** (was 255M of platform-sync junk blobs; stripped R15) [MEASURED]
- Panel session: **iframe-proof** — cookie + `Authorization: Bearer` fallback (R15); owner reported "right pass but cannot move" root-caused and fixed
- Panel vault: **EMPTY** (reset wiped all connector credentials — owner must re-enter)

## ① What happened (R11 incident + recovery)

- Sandbox was cold-reset again. Owner supplied `upload/NEXUSbot2210v2.tar` (last downloaded
  workspace backup). The tar was extracted to a staging dir, audited, then overlay-restored.
- The tar snapshot **predates the final Round-9 state**: its vault DB is EMPTY (Credential
  table has zero rows) and two Round-9 code fixes were missing. Both were re-applied by hand.
- Root cause of the original durability failure (STATE incident 2026-10-22, confirmed again):
  platform `/start.sh` restores from `/home/sync/repo.tar`; uncommitted/un-captured work dies.
  **Solution shipped this round — see ②.**

## ② Durability layer (the "proper solution" the owner asked for) — all [MEASURED]

- **Public repo push**: `scripts/snapshot-backup.sh` builds a sanitized snapshot tree
  (deny-list: `upload/ download/ db/ ops/vault/ tool-results/ agent-ctx/ directives/ tests/
  *.png *.db *.sqlite *.tar *.log` + backup state files) and pushes **fast-forward-only**
  to `specimba/NEXUSbot` `main`. First push was **seeded on the owner's remote initial
  commit** (README + LICENSE preserved; no force push, §8). Local full history
  (contains `.env` in the initial commit) **stays private forever**.
- **Fail-closed secret scan** (`scripts/secret-scan.sh`, R11-hardened): literal-only
  env-assignment pattern, index-guard refusing to run while `.env`/`db/`/vault are still
  tracked, binary/db artifacts excluded, `tests/` out of the public set. It has already
  **blocked two would-be pushes** (one of which contained a real credential literal in
  `docs/runbook.md` — scrubbed this round).
- **Secrets untracked**: `.env`, `db/custom.db`, `agent-ctx/`, `tool-results/`,
  `.zscripts/dev.pid` removed from the git index; `.gitignore` hardened.
- **Cadence**: `mini-services/backup-cadence` (port 3011, platform-managed through
  `dev.sh`) runs the snapshot every **6 h** (+ boot run, 30-min min-gap guard).
  Manual run: panel Overview → DurabilityCard → "Run backup now" (`POST /api/backup/run`,
  1/60 s rate limit) or `bash scripts/snapshot-backup.sh`.
- **Token**: device-flow OAuth token (`gho_…`, scopes `public_repo read:user`, login
  `specimba`) lives at `ops/vault/github.token`, reaches git only via `GIT_ASKPASS`
  (never argv/remote URL/config). Git history of the tar was audited: `.env` + `db/custom.db`
  exist in LOCAL history — that history is never pushed.

## ③ Connector fleet (all honest NOT-CONFIGURED until owner re-enters)

| Service | Status | Owner action |
| --- | --- | --- |
| GitHub (T-202) | appConfigured:false — App Client ID/Secret lost with vault | paste Client ID + Secret via panel (OAuth web-flow first, device flow fallback, PAT refused A8) |
| Supabase (T-203) | no PAT | paste Management PAT (`sbp_…`) — /health `services` param fix re-applied |
| Upstash (T-204) | not configured | paste REST URL + token |
| Hyperbrowser (T-205) | not configured | paste API key |
| Webshare (T-206) | not configured | paste API token |
| Durability (new) | **DOWN (honest)** — token lost with boot; chain intact (`7dcee0d`); auto-resumes on GitHub reconnect | reconnect GitHub first (row 1) |

## ④ Round-9 fixes re-applied (were lost with the reset)

1. Supabase `/health` now sends the REQUIRED `services=auth,db,pooler,rest,storage,realtime`
   param + 8 s AbortSignal timeout on all Mgmt calls (else 400 — MEASURED in R9).
2. GitHub device-flow **terminal tombstones** (bounded 50, 5-min TTL) + `terminalSeenRef`
   + `exact:true` invalidations — kills the false "device flow interrupted" toast.
3. `supabase-card.tsx` HealthSection crash on empty vault fixed (`health.data!` → guarded).
4. Connectors tab placeholder replaced — **all five connector cards now mounted**.
5. Mobile horizontal overflow (390 px) fixed (`break-all` on callback URL code).

## ⑤ Capability research (expert deep-dive, R11) — full reports in
`/tmp/r10-research/10-a-supabase-upstash.md` + `10-b-model-strategy.md` (worklog 10-a/10-b)

- **Supabase [MEASURED]**: SQL-over-PAT works (`POST /v1/projects/{ref}/database/query`,
  201, read_only default) — one PAT = full brain config plane; Edge Functions deploy API;
  Realtime broadcast; OAuth 2.1 server beta LIVE on the harness project; logs via new
  analytics endpoints.
- **Upstash [MEASURED]**: QStash 1,000 msgs/day free (queues + schedules + signatures);
  **Vector closes the embeddings gap** (server-side text embedding, 10 K ops/day free);
  Workflow durable agents (needs a public URL — decision required); Blob 1 GB free;
  Box NEXUSbotBOX1 = persistent compute escape hatch (5 CPU-h/mo free).
- **Models [MEASURED]**: Vyce = OpenAI-compatible at `https://vyceai.com/v1` (401 envelope
  verified); **Groq is WAF-blocked from sandbox egress (403)** — unreachable even with a
  valid key; classify as UNREACHABLE_FROM_SANDBOX, never KEY REJECTED.
- **Proposed brain tiers** (≈$14–16/mo blended, or $0 free mode):
  ROUTER `deepseek-v4-flash-lr` (380 ms) → WORKER `deepseek-v4-flash` →
  FRONTIER `claude-sonnet-4-6` (escalation-only) → FREE `glm-5.3-flash` + Groq satellite →
  IMAGE `grok-imagine-2`. Single OpenAI-compatible client (`src/lib/ai/client.ts` to build),
  vault keys, `/v1/models` connect-time verification, 401-never-fails-over, budget KV.

## ⑥ Owner actions now (numbered)

1. Re-enter connector credentials via panel Connectors tab (table ③) — vault was reset.
2. Confirm the public repo is acceptable as-is: github.com/specimba/NEXUSbot (`main`,
   sanitized snapshot chain). Owner-side branch protection (linear history) recommended.
3. Vyce + Groq API keys → panel (Grok key optional while egress is blocked; decide
   Webshare-proxy routing for Groq later).
4. Decide Workflow strategy: public URL for NEXUS OS (tunnel/Edge-Function bridge) or skip.
5. Optional: rotate `ENCRYPTION_KEY`/`PANEL_PASSWORD` if the old runbook password
   (now scrubbed from the repo but once written down) is concerning.

## ⑦ Next queue (after owner inputs)

- `src/lib/ai/client.ts` + model registry + `/v1/models` verification + budget KV (brain prereq)
- Supabase Mgmt-SQL client (`read_only` default) + Vector long-term memory pilot
- QStash FIFO lane for L0 stream durability + signature verification
- RSI eval scheduling via QStash cron; Workflow runner behind owner gate
- Daily immutable snapshot tags (`snapshot-YYYYMMDD`) + ≥30-min push throttle (10-b review)

## ⑧ Round-13 additions (all [MEASURED] unless tagged)

- **Egress routing layer is owner-controllable**: Webshare card → "Egress routing"
  (per-upstream direct|proxy for groq / vyce / generic-echo + default; live probe with
  honest direct-vs-proxied badges). API: GET/POST /api/egress/routing (whitelisted,
  §11, 30/min). Default map: all direct. `POST /api/egress/probe {target}` remains the
  evidence tool (groq direct → 403 UNREACHABLE_WAF [measured]; proxied side honest
  NOT_CONFIGURED until the Webshare token returns).
- **Brain client is egress-aware**: non-streaming model calls honor the routing KV
  (proxy path uses the pool, transport failures are UNREACHABLE-class, never
  KEY_REJECTED; 401 still never fails over). Streaming stays direct-only (buffered
  proxy transport cannot stream — honest limitation, not faked).
- **Groq provider slot** in the brain client: vault `groq/api-key` → Supabase
  EF-secret `GROQ_API_KEY` fallback → NO_KEY; route-aware /models with an
  embedded-fallback list [INFERRED — docs host 403 WAF too] until a proxied fetch
  succeeds. Same no-leak redaction chain as Vyce.
- **Image-credits tile** live on Overview: per-@username ledger (UsageEvent kind=image),
  totals, honest empty state; LLM usage shown as internal telemetry ONLY — never
  per-user, never currency (owner doctrine: charged per print, not per electricity).
- Vault remains EMPTY — everything above is code-verified, not credential-verified.

## ⑨ Round-14 audit results (calm pass — all [MEASURED])

- **Platform sync incident, contained**: the sandbox platform's own commit process
  gutted `.gitignore` and re-tracked `.env` + 627 `.next/` files + `db/custom.db` +
  upload/tool-results/agent-ctx into LOCAL git. **The public repo was never touched**
  (fail-closed secret-scan blocked any push; remote main still `7dcee0d`).
- **Structural immunity shipped**: scan index-guard extended (fails closed on every
  forbidden category), snapshot deny-list extended (`.next`/`.env`/`*.tsbuildinfo`),
  and `scripts/hygiene-untrack.sh` is the idempotent one-command recovery for the
  platform's next sync commit. Dry-run tree-build verified: public tree stays clean
  even from a junk-tracking local main.
- **Efficiency**: Prisma query logging off (was 281+ log lines/session, 28 lines per
  6 API calls — now 0; responses 7-11 ms); duplicate cadence processes cleaned;
  dev.log readable again.
- **Durability honestly DOWN**: the GitHub backup token was lost in a platform boot
  cycle. It resumes AUTOMATICALLY when the owner re-enters GitHub App credentials and
  clicks Connect (the connector mirrors the token to `ops/vault/github.token`).
  No snapshot has been lost — chain matches remote exactly.

## ⑩ Round-15 additions (owner bug reports → fixes, all [MEASURED])

- **"Right password but cannot move more" — ROOT-CAUSED + FIXED**: the preview panel
  embeds the app in a cross-site iframe; the browser drops the `SameSite=Lax` session
  cookie in that third-party context → login returned `{ok:true}` but the session never
  stuck (dev.log showed the owner re-logging-in in cycles). Fix: the stateless HMAC
  session token is now ALSO accepted from an `Authorization: Bearer` header by
  `requireSession()` (zero-arg signature unchanged — all 33 protected routes untouched)
  and by `/api/auth/session`; login returns the token to the just-authenticated caller;
  the client stores it (sessionStorage with in-memory fallback for Safari ITP) and an
  idempotent fetch interceptor attaches it to same-origin `/api/` requests. Cookie flow
  unchanged (curl/same-site regression-proven). Verified: fresh cookieless context
  (mirrors the iframe) → session/stats/usage 200 via bearer; tampered token → 401;
  browser E2E login → panel → tab navigation → sign-out → re-login, 0 page errors.
- **"Why is .git 300 MB?" — ANSWERED + FIXED**: the platform sync gutted `.gitignore`
  AGAIN after R14's remediation and committed Turbopack build-cache binaries (`.sst`,
  largest single blob 87 MB) + upload/ + logs into private history → 1371 loose objects,
  253 MiB. Remediation: `scripts/hygiene-untrack.sh` re-run (hardened .gitignore
  restored, junk untracked), **gut-proof `.git/info/exclude` installed** (not a tracked
  file — `git add -A` respects it even with a gutted .gitignore), private `main`
  history rewritten via index-filter (public refs excluded by design after a /tmp
  rehearsal proved `--all` would alter shallow-grafted public roots), `gc --prune=now`.
  Result: **255M → 880K** (~300×), 20/20 main commits preserved, `public-snapshot` =
  `7dcee0d` + tag `snapshot-20261023` byte-identical before/after, secret-scan OK (167
  files), dev server never touched. Auto-heal: snapshot-backup.sh now runs hygiene
  first on every run. Workspace downloads shrink accordingly.
- Panel vault still EMPTY — awaiting the owner's ④ re-entry list (GitHub Client
  ID/Secret first).

## Owner comms protocol (standing)

Every orchestrator report: ① server/preview state [MEASURED], ② changes with claim tags,
③ explicit "your actions now" list, ④ next queue. Honest zero over optimistic claims.
Secret values never printed (P7) — point to `.env` / panel instead.
