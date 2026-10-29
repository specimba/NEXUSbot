# NEXUS OS — Capability Upgrade Plan (Task 3 — v37 grounding lane)

> **STATUS: SHIPPED (2026-10-29, ~22:00 +03) — PR0–PR4 implemented, all gates green.**
> - PR0 `normalizeTr` + `capabilities.ts` ✅ · PR1 Spotify connector + 5 routes + card ✅ ·
>   PR2 grounding cards + NOWPLAYING lane + `/api/brain/nowplaying` + Brain tab ✅ ·
>   PR3 Lore Book + `/api/lore` + flip ✅ · PR4 research quality (BOT_META_TOOLS_RE, TEMPORAL_RELEASE_RE, date-stamp, relevance gate) ✅.
> - Regression: `probe-v370-grounding.ts` ALL PASS (37 checks incl. the live lore round-trip —
>   a flagged in-joke "kimdir" flipped RESEARCH→CHAT and answered from lore, live glm-5.3-flash);
>   locked suite green: v368 / v369 / v343-routing / v343-prompt-guard / v354-routing / v354-lock / search-gate — zero regressions.
> - `bunx tsc --noEmit`: zero errors in touched files; `bun run lint`: exit 0.
> - Owner E2E remaining (one-time, ~5 min): Spotify dashboard app + Client ID + redirect URI +
>   User Management email → Connectors tab → Connect. Lore entries: Brain tab → Lore Book.
>   Re-seal after connecting (auto-reseal tracks the new vault rows + settings automatically).

Owner goal: direct knowledge-grounding sync pipeline for the stream's Spotify, true capability
self-awareness, and structured smartness upgrades — additive only, zero regression on the
working brain. This is the executable design. All architecture claims below were verified
against the tree on 2026-10-29 (`[VERIFIED]` = read in code; `[TRACED]` = traced through
logic; `[INFERRED]` = reasoned; external API facts = `[EXTERNAL — re-verify at build time]`).

---

## 0. Evidence → deficit map (tonight's live log)

| # | Deficit | Root cause in code | Phase |
|---|---|---|---|
| D1 | "link açamam, tıklayacak parmağım yok" (FALSE), "sesi duyamam" with no data-feed awareness | `buildSystemPrompt()` [VERIFIED cortex.ts:1180-1289] has a KENDİNİ DOĞRU TANIT clause but no dynamic capability card; the URL reader lane (`urlAnswer()` :1849) is invisible to the persona | G2c |
| D2 | "şu an çalan şarkı" blindness | No Spotify connector anywhere [VERIFIED: zero refs in src/]; "şuan çalan şarkı ne" currently falls to CHAT [TRACED: hits no classifyIntent gate] | G1+G2 |
| D3 | "bugün çıkan oyunu adı neydi" → no date sense, no research | TIME lane answers clock/date only on ask; no date in CHAT prompt; message has no `ne zaman` (WHEN_Q_RE) and `çıkan` is not in RELEASE_VERB_RE → CHAT, model-only, stale priors [TRACED cortex.ts:456,503-505] | G2a + G4 |
| D4 | "DJ Nikolina" inside joke → Exa pipe-smoking guides | No channel-lore memory; entity questions route RESEARCH (`\bkim\b` etc.) | G3 |
| D5 | Exa off-topic answers twice; query synthesis misses antecedents | `researchAnswer()` (:2057-2163) returns ANY non-leaky Exa answer — no relevance gate; antecedent enrichment exists only for ≤80-char fragments | G4 |
| D6 | "senin araştırmalarında öyle bi isim yok mu" → web research instead of self-aware CHAT | BOT_META_RE (:568) covers prompt/!ai/command shapes, not the bot's research/tools | G4 |
| D7 | p50 6.0s / p95 14.5s | Any grounding must be cached/off-hot-path | All phases designed to this budget |

---

## 1. Verified integration seams (file:line)

- `classifyIntent()` — cortex.ts:629-685. Ladder order (locked by probes): URL-strip → TIME (≤160) → STATUS (≤160) → DRAW (≤160) → URL→RESEARCH → NEWS_RE→RESEARCH → BOT_META→CHAT → SELF_REPLYQ→CHAT (≤140) → SMALLTALK→CHAT (≤80) → RESEARCH_RE → CAPABILITY_Q_RE → TECH_EXPLAIN_RE (≥100) → WHEN_Q+RELEASE → CHAT.
- `buildSystemPrompt()` — cortex.ts:1180-1289. Numbered persona contract + memoryUsed + `Odadaki son konuşmalar` (700-char transcript) + tail block `SON EYLEMLERİN` + `HATIRLATMA` (tail-anchor is a measured design choice — cards must NOT displace it).
- Deterministic lane block — `runCortexCore()` cortex.ts:2209-2600. Precedents: TIME (zero-I/O), STATUS (blocks up to ~4s on live pings — proves a bounded blocking fetch in a tool lane is house-legal), NEWS digest (deterministic compile from cached pools).
- Research lane — `researchAnswer()` cortex.ts:2057-2163: urlAnswer(3 parallel readers) → `exaAnswer()` + leak-fuse → z-ai `runWebSearch` + grounded race → no-web race. Relevance gate slots inside the Exa rung (:2107-2124); drop falls through to the existing z-ai rung, never a dead end.
- Connector precedent — `src/lib/connectors/kick.ts`: PKCE S256 + state Map on `globalThis` (Turbopack multi-instance lesson, :42-45), single-flight refresh (:89), TOKEN_TTL_MARGIN 60s, PKCE_TTL 10min, vault labels `app`/`oauth`. Spotify mirrors this 1:1.
- Cached-pool precedent — `src/lib/brain/exa-news.ts`: Setting-backed TTL cache (15-30 min), fetch-on-read, async upsert `.catch(()=>{})`.
- Vault/crypto — `Credential` model `@@unique([service, label])`; AES-256-GCM envelope [VERIFIED schema.prisma:27-37].
- Seal — `src/lib/seal.ts:122-127` collects **ALL** Credential/Setting/Widget/IngestToken rows generically (no key/service filter); restore is upsert-merge (:307-361); auto-reseal after any Credential/Setting mutation within 45s via the Prisma extension in db.ts [VERIFIED]. **Conclusion: new keys `spotify.*`, `brain.lore`, `brain.grounding.enabled` and new Credential service `spotify` flow into the seal automatically — zero seal changes needed.**
- Setting writes — no global whitelist at DB level; each route whitelists its own keys [VERIFIED /api/settings/route.ts:9]. New keys just need their own route/lib with a whitelist + session gate.
- Panel — shell tab list is the `TABS` const in `panel-shell.tsx:36-44` (i18n labels via `src/lib/i18n.tsx`); `BrainTab` component EXISTS but is currently unmounted [VERIFIED] — the plan mounts and extends it. Connector cards live in `connectors.tsx` grid.
- Brain-token gate — `hasBrainAccess()` (brain/auth) as used by `/api/brain/context` (:30) — the natural gate for `/api/brain/nowplaying`.
- Probes — `bun scripts/probe-v368-guards.ts`, `probe-v369-guards.ts`, `v343-routing-probe.ts`, `v354-routing-probe.ts`, `v354-lock-test.ts`, `v343-prompt-guard-test.ts`, `test-search-gate.ts` import cortex.ts directly + do live `/api/brain/cortex` calls with `PANEL_PASSWORD` from `.env` [VERIFIED probe-v369 head]. New lanes MUST ship with sibling probes in this style.

## 2. What NOT to touch (regression-locked)

1. Every existing regex const in cortex.ts and its ladder position (DRAW/TIME/STATUS/RESEARCH/CAPABILITY_Q/TECH_EXPLAIN/DATE_NOW/NOW_ANCHOR/CUTOFF/WHEN_Q/RELEASE_*/DRAW_NOUN/UNIQ_ID/NEWS/AI_TOPIC/SMALLTALK/BOT_META_*/SELF_REPLYQ/SELFAQ/WHO_*/LAUGHTER_*/ROLE_FRAME/APOLOGY/DARK_BIT/…). Additions only, placed below/above measured neighbors with paired probes.
2. Existing persona lines inside `buildSystemPrompt()` (v343-prompt-guard + v36 locks) — cards are appended, the `SON EYLEMLERİN`/`HATIRLATMA` tail stays LAST.
3. The research ladder rungs, model race, role bindings, health-ladder semantics, rate guard (`tool:rate-guard`), echo/dedupe ring, kick send chain (1.5s gap), webhook ingest + RSA verification.
4. Seal format + restore order. No Prisma schema change at all in this plan (Setting/Credential/Event reused) → zero migration risk.
5. The seeded Cyber AI Counter widget and its variables (edge lane reads them).
6. No new npm dependency (AGENTS.md §4.8) — Spotify OAuth is hand-rolled `fetch`+`node:crypto`, mirroring kick.ts.

---

## 3. Phase G1 — Spotify Now-Playing pipeline

**Shape**: `src/lib/connectors/spotify.ts`, vault service `spotify`, labels `app` = `{clientId, redirectUri}` (no client secret — PKCE public client) and `oauth` = `{accessToken, refreshToken, expiresAt, scope, account, savedAt, redirectUriUsed}`.

**OAuth**: mirror kick.ts — PKCE S256, `globalThis` state Map `{verifier, redirectUri, createdAt}`, 10-min TTL single-use state, authorize at current request origin, callback validates state then exchanges. Store the redirect URI used at authorization so token refresh is origin-independent.

**Fetch model (replaces "lazy poller" wording — same behavior, sharper spec)**:
- In-process snapshot cache on `globalThis` + single-flight promise dedupe (kick.ts precedent).
- `getNowPlaying("cached")` — for prompt cards: returns instantly from memory; if age > TTL (20s), fires async refresh, never awaits → zero hot-path latency [D7].
- `getNowPlaying("bounded")` — for the deterministic NOWPLAYING lane only: awaits single-flight refresh with a 1,500ms timeout; on timeout serves cached snapshot + staleness metadata. STATUS lane already blocks ~4s on live pings — a ≤1.5s bound is inside house norms.
- Panel Brain tab + OBS poll `GET /api/brain/nowplaying` every 15-20s → the panel itself is the heartbeat keeping the cache warm without any background timer or new mini-service.
- Endpoint: `GET /v1/me/player` (distinguishes playing/paused/device/progress in one call) with `/v1/me/player/currently-playing` as fallback. 204 = no active device/nothing → distinct IDLE state. Proactive refresh when `expiresAt - now < 120s`; on 401 → single-flight refresh → one retry; refresh failure → connector state NEEDS_REAUTH (card shows it, lane answers honestly, `Event spotify.reauth-required`).
- Circuit breaker: 3 consecutive transport failures → 60s cooldown, serve last snapshot if <5min old (tagged stale), else DEGRADED state.

**Persistence**:
- `Setting spotify.nowplaying` — last known snapshot (survives dev restarts; cold boot serves it only with an honest age tag or omits).
- `Setting spotify.history` — ring of last 50 `{ts, firstSeenAt, id, name, artists, album, durationMs}`, dedup by track id; written ONLY on track change, fire-and-forget — never per poll (keeps the auto-reseal cadence low: the seal refreshes after every Setting mutation).
- Both keys are covered by the seal automatically [VERIFIED seal.ts generic findMany].

**Honest states everywhere**: NOT_CONFIGURED / NEEDS_REAUTH / IDLE / PAUSED / PLAYING / DEGRADED — the card and the lane render the same enum.

**Owner one-time steps (show them IN the card's not-configured state)**: create app at developer.spotify.com/dashboard → paste Client ID → add redirect URI (card computes + displays it) → add the streamer account under User Management (dev-mode allowlist) [EXTERNAL — verify current dev-mode policy at build time]. Redirect URI must be https, except `http://127.0.0.1:<port>` [EXTERNAL]; if the panel origin is a https preview URL this is automatic — card always shows the exact string to register; Spotify allows multiple URIs so dev/prod origins can coexist.

## 4. Phase G2 — Cortex grounding (cards + deterministic lane)

New module `src/lib/brain/grounding.ts` (keeps cortex.ts one-writer); exports compile functions + in-process caches. Cards are appended to `buildSystemPrompt()` as ONE labeled block placed BEFORE the transcript line and well before the tail; hard budget **≤900 chars** with priority ŞU AN → YAYIN MÜZİĞİ → YETENEK → LORE (truncate lowest priority first).

- **(a) ŞU AN card** — `Intl.DateTimeFormat("tr-TR", {timeZone:"Europe/Istanbul"})`: "ŞU AN: bugün <gün>, <DD> <ay> <YYYY>, saat <HH:MM> (Europe/Istanbul). 'Bugün/dün/şu an' bu tarihe göre yorumlanır." Zero I/O.
- **(b) YAYIN MÜZİĞİ card** — only when snapshot fresh (<5min): artists — title (album, year), progress `m:ss/m:ss`, state, Spotify URL (omit for local files: `is_local` has none) + one instruction line: "Sesi duyamazsın; yayında çalan şarkıyı panelinden görürsün — müzik sorularına bu veriyle cevap ver." Non-blocking cached read.
- **(c) YETENEK card** — compiled from `src/lib/capabilities.ts` `getCapabilitySnapshot()` (60s in-process cache; vault reads cached — never per-message I/O): "YETENEK DURUMUN (gerçek): sesi/video duyamaz, göremezsin; !ai mesajına yapıştırılan web linkini OKUYABİLİRSİN; [spotify bağlıysa: şu an çalan şarkıyı panelinden görürsün; değilse: Spotify bağlı değil]; [exa silahlıysa: kaynaklı web araştırma hatların var; değilse: araştırma z-ai web aramasıyla]; son mesajları hatırlarsın." — this directly kills both halves of D1 (including the "link açamam" lie: the URL-reader IS a real capability the persona must claim).
- **(d) NOWPLAYING_RE deterministic lane** — new intent returned by `classifyIntent()`, placed between the SMALLTALK gate and `RESEARCH_RE` (so locked families above are untouched; TIME is safe — "şu an ne çalıyor" fails TIME_RE [TRACED: requires `saat` shapes]). Gate: `pNoUrl.length <= 160 && NOWPLAYING_RE.test(pNoUrl)`. Route `cortex-nowplaying`, modelId `tool:now-playing`, label `VYCE // PLAK HAT`. Answers from the 6-state enum with a template pool picked by the existing deterministic variant mechanism (same packet → same line, LOCK_* precedent); ≤45 words, no emoji, no URLs unless they fit under 480 graphemes. Must-match corpus: "şu an ne çalıyor / suan ne calıyo / çalan şarkı ne / çalan şarkının adı ne / now playing / dj ne çalıyor / şu an çalan parça". Must-NOT-match (probe pairs): "healer çalıyor abi" (banter, live corpus), "bu şarkı kimin" (artist research — the fresh YAYIN card still lets a RESEARCH answer reference the current track), "saat kaç", "müzik fena çalıyo görebiliyon mu", bare spotify URLs (stay URL-lane).
- **History bonus (pulled from G5, ~15 lines)**: "geçen/önceki parça neydi" variant reading `spotify.history` — cheap because the ring ships anyway. Defer the rest of G5.

## 5. Phase G3 — Lore Book

- `Setting brain.lore` = JSON array, cap **40 entries × 400 chars**, entry `{id, aliases[≤6, each ≥3 ≤24 chars], text≤400, blockResearch?:bool, updatedAt}`. Owner CRUD: `GET/POST /api/lore`, `PUT/DELETE /api/lore` (id in body) — `requireSession` + rate limit + key whitelist (house style) + `redactSecrets` on text at write.
- Matching: new `normalizeTr()` helper (fold İ→i, I→ı→i, ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u, strip punctuation) applied to BOTH aliases (at write) and prompt (at match) — handles diacritic-less Turkish chat ("dj nikolına"). Token containment match (no ASCII `\b` — house note at cortex.ts:446-448), rank by alias length desc; inject top-3 as: "KANAL BİLGELİĞİ (kanala ait gerçekler, uydurma değil): …".
- **Routing change vs your draft**: do NOT unconditionally short-circuit RESEARCH→CHAT on any lore hit. Inject the card ALWAYS (cheap, helps either lane); flip to CHAT only when a matched entry has `blockResearch: true` (owner opt-in per entry — set it for pure in-jokes like "DJ Nikolina", leave it off for real entities so "DJ Nikolina'nın yeni albümü çıktı mı?" can still go to research WITH lore context attached). URL-forced research is never overridden.
- Injection-bloat guard: skip lore injection when 0 matches; cap 3 entries; total card budget shared with §4.
- Lore is owner-authored (trusted), but treat as data: never instruction-shaped, wrapped as quoted facts; entry text can't exceed caps, so the worst case is bounded prompt noise, not injection [INFERRED — matches SecurityLesson trust model].

## 6. Phase G4 — Research quality

- **BOT_META_TOOLS_RE** (new sibling, OR-ed into the existing BOT_META return — the locked pattern itself is not edited): second-person shapes "senin araştırmalarında|araştırma hatların|toollarını|tool'un|web araştırma hatların" → CHAT. Must NOT match imperative "araştır:" or third-person entity queries. Probe with the exact live rows ("senin araştırmalarında öyle bi isim yok mu", "şu toollarını düzgünce kullan") [MEASURED].
- **TEMPORAL_RELEASE_RE** (new, additive, near the WHEN_Q gate): `(bugün|dün|bu hafta|yeni çıkan|son çıkan)` AND `RELEASE_NOUN_RE` AND ≤220 chars → RESEARCH. Fixes D3's routing half; probe: "bugün çıkan oyunun adı neydi" (currently CHAT [TRACED]) → RESEARCH, regressions: "dün maçta attığın gol" (no release noun) stays CHAT.
- **Date-stamped research synthesis**: in `researchAnswer()`, if the (URL-stripped) query matches a relative-time word, prepend "Bugünün tarihi: <date>." to the Exa/z-ai query — the engine resolves "bugün" correctly. Zero model cost. This is D3's second half; the ŞU AN card alone would not have fixed it.
- **Zero-model relevance gate on the Exa rung**: extract salient tokens from the query (normalizeTr-lowered, strip ~40 TR/EN stopwords, keep len≥4 or quoted/capitalized, max 8); pass if ≥2 salient tokens appear in the answer (≥1 for single-token queries); on fail → drop the answer, write `Event {source:"connector", type:"research.relevance-drop", payload:{query, excerpt}}`, fall through to the existing z-ai rung. Two important nuances: (1) a relevance drop must NOT call `noteHealth("exa", false)` — Exa answered, it was off-topic; keep the health ladder truthful; (2) tune the threshold from the logged events, never from vibes. Conservative by default: a false pass is a bad answer, a false drop costs one web-fallback rung (already exists).

## 7. Phase G5 — deferred (unchanged, with two pull-forwards)

Pulled into this cycle: song-history answer (§4), `getCapabilitySnapshot()` lib (§4c — the future `/api/brain/capabilities` becomes a thin route). Stays deferred: ASR clips, VLM thumbnails, TTS opt-in, Supabase Vector persistent memory, proactive DJ reactions (owner gate), `/api/capabilities` route itself.

---

## 8. Build order (PR sequence, each independently revertable)

| PR | Contents | Depends on | Risk |
|---|---|---|---|
| 0 | `normalizeTr` + tests; `capabilities.ts` snapshot; baseline probe run (record green) | — | none |
| 1 | G1: spotify.ts + 4 connector routes + SpotifyCard (connectors tab); states honest | PR0 | medium-external, isolated — cannot touch chat |
| 2 | G2: grounding.ts cards + NOWPLAYING lane + history ring + `/api/brain/nowplaying` + Brain tab mount (NowPlayingCard) + `brain.grounding.enabled` kill-switch | PR1 (interface only — honest states work even if PR1 unconfigured) | medium-high (routing + prompt) |
| 3 | G3: lore.ts + `/api/lore` + LoreBookCard + lore injection + `blockResearch` flip | PR2 (card block exists) | medium |
| 4 | G4: BOT_META_TOOLS_RE + TEMPORAL_RELEASE_RE + date-stamp + relevance gate + Event | none (parallel to 2/3 possible, serialize if probe churn) | medium-high |
| 5 | docs (this file + ADR-004 Spotify PKCE + runbook + STATE/worklog/CHANGELOG) | all | none |

Each PR ships with its own probe script (`probe-v370-nowplaying.ts`, `probe-v371-lore.ts`, `probe-v372-research-gate.ts`) and the full regression suite below.

## 9. Edge cases & failure states (yours + found)

- **Token expiry mid-stream**: proactive refresh (120s margin); 401 → single-flight refresh → retry once; rotation persisted if Spotify returns a new refresh_token (kick.ts pattern already handles rotation-persist).
- **204 vs paused vs no-device**: three distinct states (IDLE / PAUSED / PLAYING); paused answers "duraklatılmış: X".
- **Spotify API down**: 1.5s timeout, 3-fail circuit breaker → 60s cooldown → cached-with-age or DEGRADED honest line; Event `spotify.transport-fail`.
- **Preview-origin redirect URI changes**: authorize uses the CURRENT origin and stores the URI used; refresh never needs the origin again; card recomputes + displays the URI to register; multiple URIs allowed in the dashboard. Loopback caveat: use `127.0.0.1`, not `localhost`, for local http [EXTERNAL].
- **PKCE state TTL**: 10 min, single-use, `globalThis` map; dev `--hot` reload wipes it mid-flow → click Connect again (note in runbook, not a code problem).
- **Lore prompt-injection**: owner-trusted, capped (40×400), top-3 inject, quoted-as-data framing, `redactSecrets` at write; viewers can at worst *trigger* an owner-written fact by saying an alias — acceptable.
- **Turkish text normalization**: `İ/ı` case-folding pitfall (never plain `toLowerCase()` — use the explicit map); ASCII `\b` never matches Turkish stems (house note cortex.ts:446).
- **Track titles containing trigger words**: deterministic lanes only test the viewer prompt, never snapshot/card content [VERIFIED in code] — no routing contamination from song titles.
- **"şu an" collision with TIME**: TIME_RE requires saat-shapes [TRACED]; paired probe asserts both directions ("şu an saat kaç"→TIME, "şu an ne çalıyor"→NOWPLAYING).
- **Rate/quota**: poll ≈3 req/min worst case — far under Spotify's documented ceiling; chat spam cannot amplify it (single-flight + TTL).
- **Seal churn**: Setting writes only on track change (~once per song) and lore edits; reseal cost negligible; seal counts grow by 2-3 keys + 2 Credential rows.
- **Cold boot**: no in-memory snapshot → cards omit YAYIN (honest), lane does one bounded fetch; InteractionLog/Setting-based surfaces unaffected.
- **Kick grapheme limit**: lane templates ≤45 words pass `stripEmoji` + outbound lint by construction (template pool, LOCK_* precedent); replies ride the existing 1.5s send chain + rate guard — no transport changes.

## 10. Panel / API surface map

- **Connectors tab**: `SpotifyCard` (grid, after KickCard): NOT CONFIGURED (shows Client ID field + computed redirect URI + dashboard steps) → CONNECTED (account, last fetch, current state, disconnect) → NEEDS_REAUTH (reconnect button).
- **Brain tab**: mount existing `BrainTab` (role bindings) in `panel-shell.tsx` TABS (`nav.brain` i18n keys both languages) and extend with: NowPlayingCard (react-query refetchInterval 20s on `/api/brain/nowplaying` — doubles as heartbeat), LoreBookCard (CRUD + alias preview + match tester), CapabilityCard (snapshot render; future `/api/brain/capabilities` is a thin route over the same lib).
- **API**: `/api/connectors/spotify/{status,oauth,callback,disconnect}` (session-gated, kick.ts route shape), `/api/brain/nowplaying` (`hasBrainAccess` + rate limit 120/min, `no-store`), `/api/lore` (session-gated CRUD, whitelisted schema, rate-limited).

## 11. Validation checklist (per PR + global)

**Regression gates — run BEFORE and AFTER every PR, all green:**
`bun scripts/probe-v368-guards.ts` · `probe-v369-guards.ts` · `v343-routing-probe.ts` · `v343-prompt-guard-test.ts` · `v354-routing-probe.ts` · `v354-lock-test.ts` · `test-search-gate.ts` · `tests/verify-core.sh`
**Per-PR new probes** (classifyIntent unit assertions + live `/api/brain/cortex` golden rows, incl. the exact D1-D6 log lines as fixtures):
- NOWPLAYING: 10 must-match / 10 must-not-match rows; lane 6-state replies (fixture-injected snapshots — no mock mode in prod paths, AGENTS.md §1 "no unlabelled mock"); "şu an saat kaç" stays TIME.
- Lore: alias hit injects card (prompt contains it), `blockResearch` flips only flagged entries, top-3 cap, "X'in yeni albümü" keeps RESEARCH.
- Research: the measured "nikolina"/"TRDizin" rows drop + fall to z-ai rung; `research.relevance-drop` Events present; 20 legit research rows still pass the gate; date-stamped queries carry the current date.
**Static**: `bun run lint` + `bunx tsc --noEmit` clean.
**Perf**: re-run `scripts/cron-20261029-2055-perf-probe.ts`; assert card compile <1ms and no new I/O on the CHAT path (code-review assertion: `getNowPlaying("cached")` never awaited on prompt build).
**Durability**: seal → restore drill (`tests/restore-drill.sh`); verify new `spotify.*`/`brain.*` Setting rows + `spotify` Credential rows survive a restore (upsert-merge).
**Secrets**: `scripts/secret-scan.sh` + gitleaks clean (Spotify tokens only ever live in the encrypted vault; card/status routes return booleans + masked previews only, P7).
**Browser**: agent-browser golden path — login → Connectors (Spotify card all states) → Brain tab (NowPlaying honest empty state, Lore CRUD round-trip) → 0 console errors.
**Manual owner E2E (once)**: Spotify dashboard registration → Connect → live "şu an ne çalıyor" in Kick chat → real track answer; pausing Spotify mid-stream → PAUSED answer.
**Docs**: STATE.md last-good commit, worklog entry, CHANGELOG, ADR-004 (PKCE choice + no-new-dependency note).

## 12. Rollback story

- Master kill-switch: `Setting brain.grounding.enabled` (default true) — one read at card-compile time; flip to false → all G2/G3 prompt additions vanish instantly, NOWPLAYING lane degrades to its not-configured answer. No deploy needed.
- Per-PR revert: each PR is additive + independently revertable; no schema migrations to unwind.
- Connector-level: Disconnect Spotify → YAYIN card + lane fall to honest NOT_CONFIGURED automatically (the 3-state design makes "unconfigured" a first-class production path, not a stub).
- Research gate: if events show false drops, raise threshold or disable the gate via the same kill-switch family (`brain.researchgate.enabled`) — z-ai rung is untouched either way.

## 13. Open questions for owner (each with a default)

1. Spotify app registration happens before PR2 E2E or after (default: after — honest states make PR2 safe either way).
2. Lore entries: owner wants a "delete-all" (default: yes, with confirm).
3. Does the OBS overlay need a public now-playing URL beyond `/api/brain/nowplaying` + existing widget token machinery (default: no — reuse the brain token; add a dedicated IngestToken only if asked).
