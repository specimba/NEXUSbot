# Changelog

All notable changes to NEXUS OS are documented here. Format: Keep-a-Changelog-lite;
versions map to milestone gates. Dates are 2026 sandbox time.

## [v38.0] — 2026-10-30 — Double-reply incident fix: send-ladder ambiguous-failure guard + 60s send-side idempotency

Live incident (reported in chat 04:37 +03 by Robotic_Darkelf_Jedi: "yukarda bir mesajima iki cevap atti, kayitlara gecsin"): one viewer `!ai` message drew TWO identical bot replies in live Kick chat. The InteractionLog held one row per exchange (its row dedupe hides identical seconds), so the duplication lived at the transport.

### Fixed
- **Self-healing Kick runtime (v38.1, same day)**: the new `recentSends` map crashed on HMR-mixed module generations (`globalThis.__nexusKickRuntime` survives recompiles and lacked the new field — `TypeError` silenced every bot send for minutes while rows kept logging "ok"). The runtime now backfills all map/promise fields at module init and both dedupe helpers self-heal (`??=`) — verified live: test send `200 {sent:true, identity:"bot"}`, immediate identical re-send `{sent:false, deduped:true}`.
- **Ambiguous-failure guard** (`sendLadderAdvance` in `src/lib/connectors/kick.ts`): the bot-send identity ladder (`bot` → `bot+chatroom` → `user`) advanced on EVERY failure — including 15s `AbortSignal` timeouts, socket errors and 5xx, where Kick may have ALREADY posted the first attempt; the re-POST then duplicated the line in chat. The ladder now advances ONLY on definitive rejections (400/401/403/404/422, or 2xx + `is_sent:false`); ambiguous failures stop it. A missed reply is recoverable, a doubled one is not.
- **Send-side idempotency** (`kickSendDedupeCheck` / `kickSendDedupeRecord`): 60-second exact-content suppression (sha256 key, FIFO 64 cap), checked INSIDE the serialized send chain so racing callers cannot both pass. Whatever path double-fires — ladder retry, webhook redelivery, echo miss, future code — the channel sees the same line once. `kickSendBotMessage` returns `deduped:true` on suppression and gains an (unused-by-default) `allowDuplicate` escape hatch.
- **Honest dedupe surfaces**: the webhook logs suppressed duplicates (`reply deduped at transport — no second post`); `/api/kick/test-chat` answers a 60s identical re-test with `{sent:false, deduped:true, note}` instead of pretending a fresh send.

### Added
- `scripts/incident-20261030-double-reply.ts` — permanent incident record (Event `incident.double-reply`, idempotent on the `v38-send-ladder-fix` marker).
- `scripts/probe-v38-send-dedupe.ts` — ladder truth table + dedupe window/TTL/FIFO probe (deterministic injected clock; zero live sends).

### Notes
- No Prisma schema change (Event reused), no new dependency, no lane/prompt/persona edits; dedupe is transport-level so every caller (webhook, deep-research lanes, test-chat) inherits it unchanged. Incident record: Event `cmvubsxlm0000ord8pb0kjs5x`.

## [v37.0] — 2026-10-29 — Grounding lane: Spotify now-playing + capability self-model + Lore Book

Owner directive (trace 1a188df1be629f19): "multiple misunderstanding and not realised itself capabilities also our spotify stream … direct knowledge grounding sync pipeline … capability upgrade plan integration to our system without braking working sides." Full design + evidence map: docs/capability-upgrade-plan.md; regression gates: scripts/probe-v370-grounding.ts (ALL PASS) + the locked suite (v368/v369/v343×2/v354×2/search-gate — all green, zero regressions).

### Added
- **Spotify connector** (`src/lib/connectors/spotify.ts`, PKCE public client — NO client secret, read-only scopes `user-read-currently-playing user-read-playback-state`): honest six-state machine (NOT_CONFIGURED / NEEDS_REAUTH / IDLE / PAUSED / PLAYING / DEGRADED), single-flight token refresh, 3-fail circuit breaker (60s), snapshot persisted to Setting `spotify.nowplaying` + 50-entry play-history ring `spotify.history` (write-on-change only). Routes: `/api/connectors/spotify/{status,app,authorize,callback,disconnect}`. Card: Connectors tab → "Spotify Grounding" (dashboard steps + exact redirect URI + connect/disconnect). Vault rows auto-flow into the encrypted seal (generic collector).
- **Grounding cards** (`src/lib/brain/grounding.ts`, injected into `buildSystemPrompt` as ONE ≤900-char block): ŞU AN temporal card (D3), YAYIN MÜZİĞİ now-playing card when fresh <5min (D2), YETENEK dynamic capability self-model compiled from live vault state (D1 — kills the "link açamam" lie: the URL reader lane is claimed), LORE card (D4). All sync/cached reads — zero hot-path I/O (D7). Master kill-switch: Setting `brain.grounding.enabled`.
- **NOWPLAYING deterministic lane** (route `cortex-nowplaying`, modelId `tool:now-playing`, label `VYCE // PLAK HAT`): "şu an ne çalıyor / çalan şarkı ne / dj ne çalıyor / now playing" answered from real data, zero model, bounded ≤1.5s; history variant ("geçen parça neydi") reads the ring.
- **Lore Book** (Setting `brain.lore`, seal-covered, 40×400 cap): owner CRUD `/api/lore` + Brain-tab card; normalizeTr alias matching (diacritic-insensitive Turkish fold); `blockResearch` flag flips RESEARCH→CHAT for pure inside jokes only (the "DJ Nikolina" class) — unflagged entities keep their research path with lore context.
- **Research quality** (D5/D6): BOT_META_TOOLS_RE (bot's own research/tools questions → CHAT), TEMPORAL_RELEASE_RE (relative-time + release noun → RESEARCH), date-stamped research synthesis (engine gets today's date), zero-model Exa relevance gate (≥2 salient tokens or drop → Event `research.relevance-drop` → z-ai rung; exa health ladder never poisoned).
- **Brain tab** (panel-shell): the previously-unmounted tier registry (R18-b) now lives under a Brain tab with NowPlayingCard (the 20s heartbeat keeping the snapshot warm — no background timer, no new mini-service) and LoreBookCard. `/api/brain/nowplaying` (brain-token gated) exposes the feed for OBS widgets.
- `src/lib/capabilities.ts` (cached capability snapshot), `src/lib/brain/normalize-tr.ts` (Turkish-correct fold), probe `scripts/probe-v370-grounding.ts`.

### Notes
- Spotify is honest NOT-CONFIGURED until the owner connects (dashboard steps in the card); every lane state is a real production path, not a stub. Re-seal after connecting (auto-reseal covers the new rows automatically).

## [v35.0] — 2026-10-29 — RSI Lab (experimental): L3 eval suites + L4 evolution cycles

### Added
- Eval tab unlocked (G6 opened by owner directive 2026-10-29) → RSI Lab: Overview / Research / Suites & Runs / Cycles.
- 8 Prisma models (RsiPaper, RsiSuite, RsiTask, RsiPlugin, RsiCycle, RsiCycleEvent, RsiRun, RsiImprovementEdge) + `/api/rsi/*` routes (session-gated, rate-limited).
- Engine `src/lib/rsi/`: 9-stage cycle spine, gates G1/G2/G3/G5/G7/G8 (G4/G6 honest PENDING), hash-chained audit events, frozen judge rubric via z-ai SDK, daily call budget with loud aborts.
- 5 frozen suites / 23 tasks seeded from the research contracts, configHash-sealed; paper library (48 owner-curated papers, arXiv-verified) with lazy seed; deep-research launcher reuses the Exa job lane.
- Research provenance: `rsi-lab-research/` (evolution-engine.json, eval-design.json, curation-papers.json).

### Notes
- Promotion = owner human gate inside the cycle; edge deploy remains a separate manual action. No improvement claims until the first full cycle [UNVERIFIED].

## [0.3.0-M2-wave2] — 2026-10-22 — full connector fleet + stream contract

### Added
- T-204 Upstash connector: REST URL+token pair vault, live PING/DBSIZE, origin-gated — verify 35/35
- T-205 Hyperbrowser connector: API-key vault, live health, minimal session create/list/stop (wss/CDP parked) — verify 39/39
- T-206 Webshare connector: API-token vault, SAFE pool view (A9: raw ip:port stripped at lib boundary, 0 leaks proven), routing OFF endpoint — verify 32/32
- T-207 Stream full (FR-17): channel identity line, sample-staleness warning, viewer window min/max/avg; optional ingest bearer token (OQ2): vault-backed, off by default, one-time creation reveal, sha256-cache (token-mode p95 13 ms) — verify 32/32
- Connectors tab mounts all five cards (Supabase → GitHub → Upstash → Hyperbrowser → Webshare)

## [0.2.0-M2-wave1] — 2026-10-22 — connectors wave + directive theme

### Added
- T-201 vault crypto: AES-256-GCM key-id envelopes (FR-11), tamper→integrity_error, rotation window support; /api/credentials (write-only custody) — verify 31/31
- T-202 GitHub connector: OAuth-redirect-first (A8) + device-flow fallback + snapshot push; honest not-configured states — verify 24/24 (owner App registration pending)
- T-203 Supabase connector: scoped Mgmt-PAT vault + live health probe (egress VERIFIED) + masked Edge-Function secrets CRUD — verify 35/35
- T-208 Settings tab (FR-18 budgets editable, FR-32 gateway-actor contract display, session policy facts) + Connectors tab (both cards mounted) + registry-complete shell — verify 36/36
- Owner theme directive: dark fallout×matrix×cyberpunk fusion default, Apple-style light secondary, header toggle (next-themes), phosphor grid/scanline ambience, mono glow brand
- Panel access doc: docs/runbook.md §0 (PANEL_PASSWORD location/rotation)

### Fixed
- Hydration mismatch from browser-extension attributes (suppressHydrationWarning on <body>)

## [0.1.0-M1] — 2026-10-22 — walking skeleton (G5 pre-merge candidate)

### L0 substrate + panel (T-101..T-110, `main` head e38f27d)
- SQLite/Prisma WAL substrate (busy-retry, single-writer §12), append-only event log,
  outbox → topic consumers with per-(topic,consumer) offsets; at-least-once, DLQ visible.
- Public rate-limited ingest (`POST /api/events`: 30/min/IP, burst 5/s, 32 KB cap,
  429/503, idempotency dedupe); session-gated panel API per frozen §11 matrix
  (env-password login, signed HttpOnly cookie, 5-fail/15-min throttle, logout invalidates).
- Job runner (lease 15 s / heartbeat 5 s / checkpoint-after-effect / budgets fail loud /
  kill-9 recovery sweep) + artifact store (sha256, integrity_error on mismatch).
- Dev ops: seed (server-stamped SYNTHETIC), backup (VACUUM INTO + artifacts tar, keep 10),
  replay (sandbox offset namespace + replayOf artifacts), retention sweep, DLQ re-drive.
- Panel UI: login gate, registry-driven tabs — Overview live tiles, Pipeline
  (events/jobs/artifacts/DLQ), Stream (viewer sparkline + !AI exchanges), honest
  placeholders elsewhere; mobile-first, 44 px targets, §8 loading/empty/error states.
- RT-05 runbook: Tampermonkey userscript → panel ingest (owner installs for the real event).

### Verification (T-111, independent verifier — full record: docs/verify.md)
- Suites t102–t110 all green; kill-9 ×3 PASS; **ingest p95 5.69 ms (< 100 ms)**;
  **restore drill 18 ms (< 60 s)**, row counts match; replay sha256 sets identical ×2;
  lint exit 0; secret sweep clean; browser walkthrough error-free.
- OPEN for G5: owner-side real userscript event (docs/runbook.md §2) + owner sign-off.
- Known finding F-1 (non-blocking, M2): `/api/jobs` + `/api/artifacts` return
  oldest-window slices once logs exceed the limit — "latest" UI surfaces need the
  stream.tsx tail pattern (docs/verify.md §7).
