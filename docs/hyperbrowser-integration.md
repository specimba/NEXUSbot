# Hyperbrowser — Deep-Dive Analysis & Integration Plan (NEXUS OS)

**Author:** agent deep-dive, 2026-10-30 · **Trace:** owner directive — "give proper deep
dive analysis with your experts on hyperbrowser capabilities and integration suggestions
scan from docs properly grounding for usage needs to our agent bot rather than making it
only chat botting dumb."

**Method:** every capability below is grounded in (a) the official docs index
(`llms.txt`, ~140 pages) with the specific pages fetched live on 2026-10-30, and (b) live
probes from this sandbox with the production vault key. Nothing here is speculative;
plan-tier limits are explicitly marked `[MEASURED]` or `[DOCS]`.

---

## §0 — Executive summary

Hyperbrowser is a **browser-cloud platform**, not just a scraper. For NEXUS it is the
missing *body* for the brain we already built: Exa finds and summarizes (fast, cheap,
$0.011/query — see the owner's Request History), but **Exa cannot render JavaScript,
cannot pass Cloudflare walls, cannot see pixels, and cannot click**. Hyperbrowser can do
all four. The correct architecture is **Exa as the reflexes (search), Hyperbrowser as the
hands (render/extract/act)** — never a replacement.

The single most important discovery of this dive: **we are on the free plan, and the
walls we keep hitting (arena.ai Cloudflare, captcha solving, 1 concurrent session) are
plan-tier gates, not integration bugs.** The integration plan below is ordered so every
phase works on the free tier; the paid-tier unlocks are listed separately in §6.

---

## §1 — Capability map (docs-verified)

### 1.1 Web API — the REST workhorse (no sessions to manage)
| Endpoint | What it does | Verified shape |
|---|---|---|
| `POST /api/web/fetch` | Load any URL in a cloud browser → markdown / HTML / links / **screenshot** / structured JSON | `{url, stealth: none\|auto\|ultra, outputs:{formats:[...]}, navigation:{waitUntil,timeoutMs≤60000,waitFor}, browser:{solveCaptchas,...}, cache:{maxAgeSeconds}}` → `{jobId,status,data:{markdown,links,metadata,...}}` `[DOCS+MEASURED]` |
| `POST /api/web/search` | Web search → clean `{title,url,description}[]` | `[DOCS]` — a backup search lane if Exa degrades |
| `POST /api/scrape` | Async scrape job → markdown/html/links/screenshot | `{url, sessionOptions:{useStealth,useProxy,proxyCountry,solveCaptchas,...}, scrapeOptions:{formats,waitFor,timeout,onlyMainContent,includeTags}}` → poll `/api/scrape/{jobId}` `[DOCS+MEASURED]` |
| Crawl + Extract | Multi-page crawls; AI structured extraction (Zod schemas) | `[DOCS]` — future deep-research enrichment |

**Key insight:** `scrape.sessionOptions` accepts the FULL `CreateSessionParams` —
stealth, proxies (with country/state/city), OS/device/locale spoofing, and captcha
solving — per job, without managing a session lifecycle.

### 1.2 Browser sessions — the deep-control tier
Playwright/Puppeteer/Selenium/WebSocket (CDP) endpoints; **stealth mode**
(`useStealth`), **CAPTCHA solving** (`solveCaptchas` — turnstile, cloudflare-challenge,
recaptcha, amazon, aliexpress), ad-blocking, **profiles** (persist cookies/localStorage
across sessions — e.g. keep a `cf_clearance` cookie warm), static IPs, multi-region,
recordings + video replay, live view, **WebMCP page tools** (invoke tools *exposed by
web pages*), credential fill (type secrets into login forms without the LLM seeing
them). `[DOCS]`

### 1.3 AI agents — browser automation with a brain
HyperAgent (open-source Playwright+LLM framework; we already run it as
`/api/task/hyper-agent`), plus hosted variants: **Claude Computer Use, OpenAI CUA,
Gemini Computer Use, Meta, Grok, Jev**. SDKs: `client.agents.hyperAgent.startAndWait()`.
`page.ai()` / `page.perform()` / `page.extract()` primitives; action caching (record →
replay without LLM calls); MCP integration. `[DOCS]`

### 1.4 Sandboxes — isolated code execution
Cloud sandboxes with **the exact images the owner already has** (default, node,
python, node-chromium, opencode, codex, claude-code, openclaw), GPU sandboxes, macOS
(beta), volumes, snapshots, secrets/vaults, terminal, networking controls. `[DOCS]`
**Verdict for NEXUS: not needed for bot runtime** — our sandbox is ~10× the resources of
any free-tier survivor (migration pass-2 conclusion). Park for future code-exec tools.

---

## §2 — What NEXUS already runs on Hyperbrowser (measured tonight)

1. **T-205 connector** (`src/lib/connectors/hyperbrowser.ts`): vault-keyed typed REST
   client; sessions create/list/get; honest probe. Key never logged (P7).
2. **v33 deep-research lanes** (`src/lib/brain/deep-research.ts`): chat lane + panel lane
   both run `exaAgentRun` first, then **HyperAgent as the browser fallback** (strict task
   template, budget-capped by `HB_DAILY_CAP`). This is the "ajan hattını açtım + tarayıcı
   yedeği" the bot announced live on 10-29 00:31 — it works (fb-Tarfin answer arrived
   with sources 25.8s later).
3. **Bench pipeline** (`src/lib/benchmarks.ts`): arena boards go direct → 403 Cloudflare
   → **hbScrape layer** → parse. Worked until arena.ai tightened its wall (§3).
4. **Vyce models panel**: JS-guarded boards render through Hyperbrowser (owner note).

---

## §3 — Tonight's live forensics: the Arena captcha wall

All five arena boards PARSE_FAILED with "SPA/layout change suspected". Probes with the
production key (2026-10-30, ~04:5x UTC):

| Probe | Result |
|---|---|
| Scrape + `useStealth` + `waitFor 3s` (the v37.1 fix) | `completed`, **489-char markdown = Cloudflare interstitial** ("Performing security verification… Verification successful. Waiting for arena.ai to respond") |
| Scrape + `waitFor 6s / 12s / 20s` | same interstitial every time — the snapshot binds to the challenge page, never the post-redirect board |
| `web/fetch` + `stealth:"auto"` | 200 in 3.5s, same interstitial |
| `web/fetch` + `waitUntil:"networkidle"` (≤60s cap) | same interstitial |
| Scrape + `solveCaptchas:true` | **HTTP 402: "Free plan does not support solving captchas. Please upgrade your plan."** |
| HyperAgent task ("wait through the challenge, reload, extract table") | ran 9 steps / 51s → `failed`, empty result |
| `GET /api/sessions` | 10 sessions, all auto-closed (housekeeping works); free plan = **1 concurrent session** (a second create → 402 while one is open) |

**Conclusion:** the Cloudflare JS challenge *passes* ("Verification successful") but the
page capture never follows the redirect. Passing it requires `solveCaptchas` — a paid
gate. **Action shipped in v37.1:** `hbScrape` now sends the documented
`{sessionOptions:{useStealth:true}, scrapeOptions:{formats,waitFor}}` shape, and the
pipeline detects the interstitial (`isChallengePage`) and reports the honest root cause
("Cloudflare bot-check page… captcha solving requires a paid plan") instead of the
misleading "SPA/layout change suspected". **The boards stay FAILED honestly until either
(§6) the plan upgrades or (recommended) the source moves** — LMArena publishes
leaderboard data as HuggingFace datasets (no wall, no browser, free) if the owner wants
the arena boards back without paying.

---

## §4 — Deficit map: chat-log evidence → Hyperbrowser capability

The Exa Request History the owner pasted is the perfect exhibit of the remaining gaps —
**raw colloquial Turkish went to Exa verbatim**:

| Live evidence (Exa history / chat log) | Deficit | Fix (lane) |
|---|---|---|
| `"galiba zaten benim bilgisayarda kripto madenciliği yapılıyo herhalde mimar geçen öle diyodu"` searched verbatim | No query rewrite — context words ("mimar geçen öle diyodu") poison the search | **P1 rewrite layer** (below) — chat model distills the *question* before any research lane fires |
| `"şarkının adını yazarsam ve adam akıllı yorum yapamazsan belanı sikerim kardeşim"` searched | Banter/threat routed to research | P1 gate + v36.x SELF_REPLYQ/rant guards (partially shipped) |
| `"şu toollarını düzgünce kullan nikolinayı öğren…"` → pipe-smoking guides | Idioms literalized by search | P1 rewrite strips idioms; lore book (shipped v37) short-circuits known entities |
| Brezilya/X reply: "Teksas'ta değil, Brezilya'da olup çeliği gevşedi" (word salad + stale fact) | Research answers ungrounded in the actual question | P1 rewrite → cleaner query; P2 page grounding |
| "bugün herkesin çok beklediği bi oyun çıktı" → "bilemem" | No proactive research on time-sensitive questions | TEMPORAL_RELEASE routing shipped v37; P2 grounds the answer in the release page |
| "sana linki atsam görebilir misin" → (now claims link reading via Exa urlAnswer — v37) | JS-heavy pages still unreadable | **P2: Web Fetch markdown lane** — full page, not a search snippet |
| DJ Nikolina: bot confidently claimed "ghost DJ" (wrong — real DJ, 26 Dec Istanbul show) | Fabricated lore from an agent | **Governance §8** — lore is owner-authored only |

---

## §5 — Integration plan (phased, non-breaking, free-tier-first)

**P1 — Research query-rewrite layer** *(highest value/effort ratio; fixes the #1 Exa
history complaint class)*
Seam: `deep-research.ts` / cortex-research entry, BEFORE `exaAgentRun`/`exaAnswer`.
One cheap chat-model call (glm-5.3-flash, ~1-2s): "Distill this Turkish chat message
into a clean English web-search query for the *actual question*; drop idioms, banter,
threats, and speaker context; return `CHAT` if no research is needed." Store the rewrite
in the interaction row for auditability. Expected: kills the verbatim-query class
(§4 rows 1-3) and reduces Exa spend (fewer junk searches at $0.011 each).

**P2 — Web Fetch grounding lane** *(the "not a dumb chatbot" upgrade)*
Seam: new `hbWebFetch()` in `hyperbrowser.ts` (thin, typed, ~40 lines — same
vault/P7/error discipline as the existing client). Call sites:
1. Research lane: when Exa returns a URL the answer leans on → `web/fetch` markdown for
   the full page → feed to the answer model (Exa summaries truncate; pages ground).
2. Link-reading lane: v37 claims link-reading via Exa `urlAnswer`; JS-rendered pages
   (SPAs, docs sites) → `web/fetch {stealth:"auto"}` as the fallback. Fixes the
   "link açamam" class completely, not just for indexable pages.
Budget: shares `HB_DAILY_CAP`; `cache:{maxAgeSeconds}` on repeat fetches.

**P3 — Screenshot → VLM lane** *(new sense: eyes)*
`web/fetch` and `scrape` both support `formats:["screenshot"]`. Vyce now exposes
**`nemotron-3.5-super-vl` (free, 380ms)** — registry role `vision` added in v37.1.
Chain: viewer asks "ekranda ne var / bu sitede gördüğün…" → fetch screenshot →
nemotron describes → cortex answers in persona. Also the stream-thumbnail VLM idea from
the capability plan §7. Gate: opt-in flag (owner decides when bot "sees").

**P4 — Deep-research agent v2 (structured tasks + WebMCP watch)**
The v33 lanes already race Exa-Agent → HyperAgent. Upgrade the HyperAgent task template
to use structured output requirements ("answer + cite every URL you actually opened"),
and — when Hyperbrowser's `page.extract()` Zod-schema extraction proves stable — prefer
it over free-text finalResult for leaderboard/ticket/price classes ("sara landry bilet
kaç para" was a measured 6.26s Exa search but 4 thin snippets; an agent that opens
Ticketmaster/TR selling pages grounds it).

**P5 — Arena boards without the wall** *(choice, owner-gated)*
Option A (free): swap arena sources to LMArena's published HuggingFace datasets —
no Cloudflare, no browser, deterministic. Option B (paid): HB plan upgrade unlocks
`solveCaptchas` and the existing pipeline heals as-is (v37.1 already sends stealth +
correct body shape). Recommended: A (data fidelity equal, zero cost, zero wall).

**P6 — MCP server exposure** *(future, when tool-use models arrive)*
Hyperbrowser ships an MCP server (docs: Model Context Protocol integration). When the
Vyce lineup gains a reliable tool-calling model, expose `fetch/search/scrape` as MCP
tools so the *model itself* decides when to open a browser — the end-state of the
"bot that uses its own tools" directive.

**Explicitly out of scope:** sandboxes for bot runtime (our sandbox is 10× any free
tier); replacing Exa (it's cheap, fast, 100% success rate this month, $8.62 total);
autonomous posting of research results without the existing dispatch/queue discipline.

---

## §6 — Plan-tier gates (measured on OUR key, 2026-10-30)

| Capability | Free (now) | Paid |
|---|---|---|
| `solveCaptchas` | ❌ 402 measured | ✅ (turnstile/cloudflare/recaptcha/amazon/aliexpress) |
| Concurrent sessions | **1** (measured 402) | more |
| Ultra stealth | ❌ enterprise | enterprise |
| Stealth `useStealth` | ✅ works (but does NOT pass arena.ai's wall) | ✅ |
| Web fetch/search/scrape, HyperAgent, profiles | ✅ | ✅ |
| Arena.ai boards | ❌ walled | ✅ with solveCaptchas |

---

## §7 — Anti-patterns (what NOT to do)

1. **Don't route chat through the browser.** Hyperbrowser answers cost more wall-clock
   (10-60s) than the cortex race budget; it's a research/grounding lane only.
2. **Don't widen HyperAgent tasks.** Owner directive (v33 header): "not random wasting
   browser" — strict templates, budgets, and the queue discipline stay.
3. **Don't trust a `completed` scrape.** Tonight proved a job can complete on a captcha
   page — every consumer must run the `isChallengePage` check (now in benchmarks.ts; copy
   into `hbWebFetch` when built).
4. **Don't hold sessions open** on a 1-session plan — create → use → auto-close, exactly
   like `hbAgentRun` already does.

## §8 — Governance lesson (DJ Nikolina, 2026-10-30)

The bot (an agent session) fabricated a lore entry ("ghost DJ") and injected it as ground
truth; the owner cleared it — Nikolina is a real DJ with a real 26 Dec Istanbul show.
**Rule, effective now: the Lore Book is OWNER-AUTHORED ONLY. Agents may *propose* entries
in panel notes; they may never write, pre-load, or "seed" lore themselves.** The v37
capability plan's "nikolina is done" line is void; the deficit it addressed (unknown
entities) is instead handled by P1 (rewrite) + honest research, never by fabrication.

## §9 — Sources

- Docs index: `https://www.hyperbrowser.ai/docs/llms.txt` (~140 pages, fetched 2026-10-30)
- Pages fetched live: `web/overview`, `web/fetch`, `web/search`, `web-scraping/scrape`,
  `api-reference/create-new-scrape-job` (full OpenAPI), `api-reference/fetch-a-web-page`
  (full OpenAPI), `sessions/captcha-solving`, `sessions/stealth`, `agents/hyperagent`
- Live probes: see §3 (this sandbox, production vault key, 2026-10-30)
- Internal: `src/lib/connectors/hyperbrowser.ts` (T-205 header ledger),
  `src/lib/brain/deep-research.ts` (v33 lanes), `src/lib/benchmarks.ts` (v37.1),
  Exa Request History + Usage (owner paste: 535 req/30d, 100% success, $8.62)
