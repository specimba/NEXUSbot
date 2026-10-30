# NEXUS OS — AgentMail & Agent-Systems Deep Dive (v37.1 → v37.3)

> **STATUS: DELIVERED + LIVE-VERIFIED (2026-10-30 ~06:30 +03). v37.3 ADDENDUM
> below (§8) — threads, daily digest, mail→bot command lane, scan-scrub,
> EN panel pass — all shipped 02:43–03:00 +03.**
> - Analysis grounded in owner paste `upload/AGENTMAILautomatedNEWagentSYSTEMSguide3010.txt`
>   (612 KB, 16.9k lines) + **live API probes with the owner's real keys,
>   2026-10-30 04:30–06:30 +03** (all `[MEASURED]` ran against production).
> - **Shipped**: 5 vault credentials · 4 connector libs · 10 API routes · 2 panel
>   cards · Keenable free research rung in the brain · TinyFish+Firecrawl bench
>   rungs (6/6 sources green, was 1/6) · Nikolina truth lore (live-verified
>   answer) · lore write-race + grounding-budget bug fixes · beam-1.0 reroute.

Owner ask: *"give proper deep dive analysis with your experts on hyperbrowser
capabilities and integration suggestions… rather than making it only chat
botting dumb"* + *"this new experimental agent mail and related connected
capabilities."* This is that analysis, grounded in the captured docs + live
probes, with the integration already shipped.

---

## 1. What the capture actually contains (inventory)

| System | What it is | Owner account state | Key facts |
|---|---|---|---|
| **AgentMail** (agentmail.to) | Email provider built for AI agents — API-first inboxes, threads, webhooks, WebSockets, IMAP/SMTP, per-inbox allow/block lists, pods (multi-tenant), **Agent Armor** (inbound prompt-injection scanner), calendar, drafts, attachments | Free Tier org "Canberk's organization" (specimba@gmail.com); inbox **nexusagent1@agentmail.to** (1/3 used); 9 received / 1 sent in 24h; 129 KB / 3 GB storage; Labs + Agent Armor **enabled since 2026-10-29 20:36 UTC** | Full Access keys ×2 (webguitest1/2) `[MEASURED auth/me → organization scope]` |
| **Keenable** (keenable.ai) | Web search + page fetch API behind the CLI/MCP; ~every partner MCP catalog in the capture (xAI, Higgsfield, OpenReview, OpenRouter, Letterboxd, ElevenLabs, AA benchmarks, Fed, CNF, Wayfair, NJ licenses…) routes through it | **100,000 free requests**, renews Nov 29; 10 req/s org limit; SELECT (table-answer) free until Nov 1 | `POST /v1/search`, `GET /v1/fetch` `[MEASURED both 200]` |
| **TinyFish** (tinyfish.ai) | Agent browser-automation platform: Agent API (automation runs, browser context profiles), Browser API (CDP WebSocket), Fetch/Search/Extract APIs, **Monitor API** (cron'd page/topic monitors → webhook) — **every session runs behind a US residential proxy by default** | search+fetch **free on every account**, no credits | `POST api.fetch.tinyfish.ai` `[MEASURED 200]` |
| **Firecrawl + Alexandria** (firecrawl.dev) | Scrape/crawl/search + the "Alexandria" provider marketplace (Apollo people-enrichment, Fiscal.ai finance, Particle podcasts, Shopify catalog…) | **1,400 credits**, resets Nov 29 | `POST /v2/scrape` `[MEASURED 200, ~1 credit/scrape]` |
| **Supermemory** (console pages in capture) | Agent memory API v5, namespaces, memory graph, connectors | Account exists (v5 announced Oct 7) | Not wired this pass — parked §7 |
| **InstaCloud** (docs.instacloud.com) | Agent hosting platform (orgs→projects→apps, secret bindings, per-project tokens) | Docs only, no key in capture | Parked §7 |

**Vault after this session (19 credentials):** `agentmail/api` (webguitest2),
`agentmail/api-backup` (webguitest1), `keenable/api`, `firecrawl/api`,
`tinyfish/api` + the 14 pre-existing.

---

## 2. AgentMail — capability map `[MEASURED against openapi.json]`

Full surface extracted from `https://docs.agentmail.to/openapi.json` (the file's
console screenshots only hinted at part of it):

- **Inboxes**: create thousands via `POST /v0/inboxes`; inbox_id IS the email
  address; per-inbox API keys with narrow scopes (Message Read/Send);
  authorize, custom domains (DKIM/zone-file flow).
- **Messaging**: `POST …/messages/send` (to/cc/bcc, text+html, labels,
  `track_opens`, attachments via files API, idempotency keys), reply / reply-all
  / forward / batch-get / batch-update, **reply & attachment extraction**
  (strips quoted history into `extracted_text`; parses PDF/Word/Excel/txt
  attachments server-side — no Talon needed).
- **Threads**: first-class, org-wide search (`/v0/threads/search`).
- **Realtime**: webhooks (event `message.received` etc. + polling webhooks —
  a pull-based variant that still needs an HTTPS endpoint) and **WebSocket
  subscriptions** (no public URL needed — the capture notes this explicitly as
  the fastest path).
- **Agent Armor** (Labs, free while in Labs): scans every inbound message for
  prompt injection, returns `{status, verdict, reason, model}` per message;
  Monitor mode (default — delivers, verdict follows within seconds) vs **Hold
  mode** (`review` verdicts hold `message.received` until a human releases via
  console or `POST …/agent-armor/release`). Feedback endpoint feeds the scanner.
  `[MEASURED: our self-sent probe came back verdict:"clear", model:"qwen3.8-27b-fp8-choice-v3"]`
- **Lists**: per-inbox/org allow+block lists, per direction (send/receive).
- **Calendar**: per-inbox agenda, iMIP invitations, webhook on event start.
- **IMAP/SMTP**: full protocol access (the differentiator table: traditional
  APIs are API-only).
- **MCP**: hosted server `https://mcp.agentmail.to/mcp` (x-api-key header);
  skills repo `agentmail-to/agentmail-skills`; llms.txt + `.md` doc twins +
  `searchDocs` MCP at `docs.agentmail.to/_mcp/server`.

**Free tier posture**: 3 inboxes, 100 emails/day, 3 GB, sending rate-limited in
the first week (3 recipients/1h → 5/1d → 10/1w) — irrelevant for our volume.

---

## 3. Live probe evidence (2026-10-30, all `[MEASURED]`)

| Probe | Result |
|---|---|
| `GET /v0/inboxes` | 200 — `nexusagent1@agentmail.to`, org `a7c22628…`, created 2026-10-29 19:29 UTC |
| `GET …/messages?limit=3` | 200 — real inbound (s2.dev founder welcome et al.), full headers, labels, previews |
| `GET …/threads` | 200 — thread view with senders/recipients/preview |
| `POST …/messages/send` (self→self) | 201 — message_id + thread_id returned, message arrived in inbox within seconds, **Agent Armor scanned it (verdict clear)** |
| `GET /v0/auth/me` | 200 — organization-scope full-access key |
| `POST /v0/organizations/labs` | 200 — `{enabled:true}` (already on since 10-29 20:36) |
| `GET /v0/organizations/me` | 404 `not_found` — no such route (org info comes from inboxes payload) |
| Keenable `POST /v1/search` "DJ Nikolina Istanbul 74 Hall konser" | 200 — **found the evidence Exa never could**: BUGECE + RA + Consequence listings, "Nikolina, flying in from Berlin", 74 Hall Bakırköy İstanbul |
| Keenable `GET /v1/fetch` (AA model page) | 200 — clean markdown, metered fields |
| Keenable `POST /search` (wrong path) | `{"error":"Not found"}` — doc ground truth: `/v1/search` |
| TinyFish `POST api.fetch.tinyfish.ai` (AA leaderboard) | 200 — JS-heavy leaderboard as markdown (the arena.ai class of pages) |
| Firecrawl `POST /v2/scrape` | 200 — clean AA model-page markdown, burns ~1 credit |

**The Nikolina lesson, quantified**: the same entity that Exa returned
pipe-smoking guides for (3s, $4/1k) came back from Keenable in one FREE call
with three ticketing sources. That's the core integration insight — not
"replace Exa" (owner doctrine: use the best tools), but **a free second lane
that catches exactly the Turkish-collouqial failure class**.

---

## 4. Integration architecture (shipped in v37.1)

```
                        ┌──────────────────────────────────────────────┐
                        │  NEXUS OS panel (/ — the only route)         │
                        │  ┌──────────┐  AGENT POSTA tab (§4.3)       │
                        │  │ Vault 19 │◄─ credentials/api (agentmail, │
                        │  └──────────┘  keenable, firecrawl, tinyfish)│
                        └───────────────┬──────────────────────────────┘
                                        │ API routes (all relative, 3000)
        ┌───────────────┬───────────────┼────────────────┬───────────────┐
        ▼               ▼               ▼                ▼               ▼
 /api/connectors/  /api/connectors/  /api/connectors/  /api/connectors/  brain
 agentmail/*       keenable/*        tinyfish/*        firecrawl/*      lanes
   status           search            fetch              scrape         │
   inbox (10)       (free lane)       (free JS pages)    (1.4k credits) │
   send (test)                                                                  │
        │               │                │                │               │
        ▼               ▼                ▼                ▼               ▼
   api.agentmail.to  api.keenable.ai  api.fetch.tinyfish.ai  api.firecrawl.dev
   (Agent Armor      (100k free)      (residential proxies)  (Alexandria)
    on every inbound)
```

### 4.1 Why each lane exists (deficit → fix)

| Deficit observed live | Fix | Evidence |
|---|---|---|
| Research lane burns $8.62/mo Exa on queries where it demonstrably fails (Turkish colloquial entities) | **Keenable as the FREE research fallback** — after Exa returns irrelevant/empty AND for queries dropped by the zero-model gate, Keenable answers with sources at $0 | Nikolina probe: 3 ticketing sources, 1 free call |
| arena.ai 5 boards PARSE_FAILED (SPA + captcha on Hyperbrowser scrape) | **TinyFish fetch** (JS-rendered, residential-proxy egress) as the bench fallback reader for the JS-board class; Firecrawl v2 as the paid second fallback | AA leaderboard fetched clean via TinyFish `[MEASURED]` |
| Bot has no outbound asynchronous channel — every capability is synchronous chat | **AgentMail**: the bot can now send/receive email as an agent (nexusagent1@agentmail.to), with inbound scanned by Agent Armor before anything acts on it | Send lane MEASURED self→self |
| Panel shows only 6 connector states | New connectors surface in the same Connectors pattern + a new AGENT POSTA section: inbox feed (10 latest), armor verdicts, send-test | §5 UI |

### 4.2 What is deliberately NOT wired yet (and why — parked §7)

- **Webhooks/WebSockets inbound push**: the sandbox only exposes port 3000
  through the gateway; AgentMail webhooks need a public HTTPS URL.
  `nexusbot.space-z.ai` IS public — wiring a `/api/connectors/agentmail/webhook`
  route is possible but the gateway/caddy path needs a deliberate decision
  (plus the panel route discipline "only / visible"). Until then the inbox is
  **pull-based** (status/inbox routes poll on panel demand; a cron digest could
  poll on cadence). Documented, not blocking.
- **Mail→bot command execution**: anyone can email the inbox; the docs warn
  exactly this ("anyone can email your agent's inbox"). When we do wire it,
  the design is already fixed by the docs: **Agent Armor Hold mode + sender
  allowlist (specimba@gmail.com only) + list entries**, verdict-gated, with
  the release flow human-in-the-loop. Not this pass — the panel first proves
  the read/send lanes.
- **Supermemory / InstaCloud**: no live credential in the capture for these;
  parked with concrete next steps (§7).

### 4.3 Panel surface (AGENT POSTA)

- Inbox card: address, org tier (Free), messages 24h, storage, Agent Armor state.
- Message feed: 10 latest (from/subject/preview/labels/armor verdict badge).
- Send test: to/subject/text → `/messages/send`, honest error surface.
- Connector cards for Keenable/TinyFish/Firecrawl in Connectors: key present +
  masked, one MEASURED probe each.

---

## 5. Cost model (honest numbers)

| Lane | Cost | Budget posture |
|---|---|---|
| Keenable search/fetch | **$0** (100k req window, renews Nov 29) | Default fallback — free |
| TinyFish fetch/search | **$0** ("free on every account") | JS-page reader — free |
| Firecrawl scrape | ~1 credit/scrape of **1,400** (resets Nov 29) | Reserved: only when TinyFish+Keenable both fail a page |
| AgentMail | $0 (Free tier, 100 sends/day) | Async channel — free |
| Exa | $4/1k search, $5/1k answer (~$8.62/mo current burn) | Stays PRIMARY (owner doctrine) — Keenable catches its failures |

Net effect: the research floor gains two free lanes + one metered backup before
any fallback ever touches money.

---

## 6. Relation to the pending directives (closed in this pass)

1. **DJ Nikolina lore** — the poison entry ("hayalet DJ, web'e kapat") was
   already gone from the live DB (brain.lore = `[]`); root cause: it made the
   bot state the lie confidently. **Correct entry now written** (aliases:
   dj nikolina/nikolina/nikolınah/nikolinanın/nikolina dj; ground truth: real
   DJ, 26 Aralık İstanbul 74 Hall, duyuru 30 Ekim 2026; blockResearch=true so
   the lane is deterministic). Keenable's ticketing evidence corroborates the
   owner's fact. **Two deeper bugs found and fixed while verifying the fix
   live [MEASURED]:**
   - **Lore write race** (lore.ts): `upsertLore` did read-modify-write against
     the 60s in-process cache — a cross-process write (my direct-DB script)
     was invisible to the dev server's cache and the next panel probe write
     persisted a STALE list, silently wiping the new entry. All lore mutation
     paths now read the live DB row (`readLoreFresh`); the read-path TTL is
     enforced again (it had gone unused — the cache never expired).
   - **Grounding budget trim** (grounding.ts): with a warmed YETENEK capability
     card (~650 chars) the 900-char grounding block overran and the tail-trim
     silently dropped the LORE card — the ONE section answering the question
     asked ("dj nikolina kimdir" → "bilmiyorum" while the card existed in the
     store). LORE now rides second (after ŞU AN); YETENEK is the first thing
     the budget may drop. **Live-verified**: the brain now answers
     "dj nikolina kimdir kanka" with "DJ Nikolina GERÇEK bir DJ, hayalet
     değil. 26 Aralık 2026'da İstanbul 74 Hall'de sahne vereceğini duyurdu"
     (route=cortex-chat, engine=beam-1.0, lore card in prompt).
2. **Vyce model update** — glm-5.3-flash was UNSTABLE at 26.4s platform
   latency. v37.1 race: **beam-1.0 (380ms) banter lead**, glm-5.3-flash demoted
   to backup 1 (race picks it back up when the platform recovers), deepseek-v4.1
   last-ditch; frontier lane unchanged (claude-sonnet-4-6). The lane label is
   now derived from the CURRENT primary (`VYCE // BEAM 1.0`), never a hardcoded
   predecessor label — measured: 80+ live beam-1.0 answers in the first hour.
3. **Arena captcha** — **SOLVED, 6/6 sources green** [MEASURED live refresh]:
   the bench pipeline gained two new egress rungs inside the challenge-page
   branch — TinyFish (free, residential-proxy; passes Cloudflare on
   arena-chat / arena-agent / arena-agent-alignment) and Firecrawl (metered
   ~1 credit/board; passes on the two boards TinyFish blocks —
   non-english / multi-turn). Plus a pipe-table markdown parser for both new
   board shapes (fused "1 11" rank cells; `<br>`-segregated Firecrawl name
   cells). Final states: arena-chat 300 models via tinyfish · non-english 300
   via firecrawl · multi-turn 300 via firecrawl · agent 55 via tinyfish ·
   alignment 27 via tinyfish · aa-index 28 direct. Was 0/5 arena boards
   PARSE_FAILED.
4. **Hyperbrowser deep dive** — this doc IS the requested analysis, extended to
   the full agent-systems capture (hyperbrowser-integration.md covers the HB
   side; the Stealth & Proxies lane stays parked — the arena boards no longer
   need it, the TinyFish/Firecrawl ladder measured through the wall).

---

## 7. Parked queue (next passes, in value order)

1. ~~Bench lane v2~~ **DONE in this pass** — TinyFish + Firecrawl rungs live,
   6/6 sources green.
2. **AgentMail webhook**: `POST /v0/webhooks` → gateway public URL, event
   `message.received` + `message.security.completed`; then Hold mode; then the
   owner-allowlist command lane (mail → panel command, verdict-gated).
   **v37.3: the command lane is live PULL-BASED (see §8) — the webhook push
   half stays parked (public-URL decision).**
3. **Daily digest**: cron 06:00 → nexusagent1 → owner email: yesterday's
   InteractionLog stats, research spend, bench deltas (uses send lane + usage
   routes; all measured already). **v37.3: LIVE — see §8.**
4. **Keenable SELECT** (table answers) once free-window behavior confirmed.
5. **Supermemory**: namespaces per viewer → memory graph; needs its own key.
6. **InstaCloud**: hosting redundancy for a bot failover instance.
7. **Hyperbrowser Stealth & Proxies** root-cause probe — deprioritized: the
   bench no longer needs it.

---

## 8. v37.3 addendum (2026-10-30 ~02:45 +03) — shipped + verified

Owner feedback on v37.1: (a) the two new panel cards shipped in Turkish while
the whole panel is EN; (b) the snapshot push kept failing "secret scan found
hits" even after a fresh GitHub handshake; (c) re-check the guide for missed
platform capabilities. All three, root-caused:

1. **Scan-abort root cause — plaintext keys in the import script.**
   v37.1's `scripts/import-agent-creds.ts` embedded the five owner keys as
   literals; the Tinyfish key (`sk-tinyfish-…`) matches the scanner's
   openai-style pattern → every run from 02:33 correctly aborted (the GitHub
   handshake was never broken — the scan fires before any push). The other
   four literals matched no pattern: had the scanner been pattern-unlucky the
   keys would be on the public repo now. Fix: the script carries ZERO literals
   and extracts keys structurally from `upload/…` (never leaves the sandbox) at
   runtime; re-run measured idempotent (same 5 masked prefixes, 19 vault
   credentials). **SCAN OK → PUSH OK 9f6c85a + TAG snapshot-20261030-0244.**
2. **EN pass**: AGENT MAIL + WEB LANES cards fully rewritten in EN (badges,
   feeds, toasts, placeholders, aria-labels) — panel language is consistent
   again.
3. **Threads** (the "threads" promised in the P2 surface, §4.3):
   `listAgentMailThreads` (lib) + `GET /api/connectors/agentmail/threads` +
   an inbox⇄threads toggle in the AGENT MAIL card. Thread rows are mapped
   defensively (field names picked with fallbacks — the live feed decides).
4. **Daily digest** (§7.3): `buildAgentMailDigest` (Istanbul calendar-day
   aggregates: InteractionLog ok/error/viewers/latency/models, UsageEvent
   llm/image, vault count, backup state — DB+fs only) +
   `sendDailyDigest` (yesterday → owner) + `POST /api/connectors/agentmail/digest`
   (body `{}` sends, `{preview:true}` builds without sending) + card buttons
   (send now / preview).
5. **Mail→bot command lane** (P3, §4.2 design, pull-based — no webhook needed):
   `pollAgentMailCommands` + `POST /api/connectors/agentmail/commands`.
   **Triple gate** before any execution, exactly as the platform docs
   prescribe: (1) sender = owner only (`specimba@gmail.com`, display-name
   aware), (2) `agent_armor.verdict === "clear"` — "review"/"unavailable"
   treated exactly as the docs tell listing agents to treat held mail,
   (3) strict subject whitelist `help|status|digest|ping|uptime` (optionally
   `nexus <cmd>`) — no LLM, no body parsing, no injection surface. Replies ride
   the send lane. Cursor semantics (Setting `agentmail.commands.cursor`):
   initialized to now (mail predating the feature is never auto-executed);
   owner messages still armor-"pending" stay behind the cursor and are
   re-examined next poll (scans finish in seconds; "unavailable" is terminal
   and advances past).
6. **Cadence**: `scripts/mail-cadence.ts` (one-shot: command poll every run +
   digest once per Istanbul day in the 05:00–12:00 window, dedupe =
   Setting `agentmail.digest.lastDate` — a panel digest never claims the day)
   spawned by `mini-services/mail-cadence` (:3013, every 30 min, registered in
   scripts/spawn-minis.ts). First live runs measured honest: `COMMANDS OK:
   scanned 11, nothing to run (…old 11)` + `DIGEST SKIP: outside window`.

**§7 queue after this pass:** #2 webhook-push half only; #3 closed; #1/#4/#5
remain (SELECT window, Supermemory key, InstaCloud).

---

*Evidence trail: probes run 2026-10-30 04:30–05:30 +03, keys from the owner's
capture file (now vault-only). InteractionLog rows cmvtu* document the ghost-DJ
lie this pass closes. Vault: 19 credentials. This doc: docs/agentmail-deep-dive.md.*
