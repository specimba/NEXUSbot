# docs/scope.md — NEXUS_BOT (system: NEXUS OS) v1

**Status:** APPROVED AT G0 WITH AMENDMENTS — owner sign-off received 2026-10-21 (see §10). Sections 1–9 stand; §10 amends where the owner overrode defaults.
**Authority:** `directives/PROJECT_DIRECTIVE.md` v3.0 §0. If this file and the directive disagree, the directive wins.
**Date:** 2026-10-21 · **Owner:** single primary operator/architect · **Mode:** multi-agent (MoE) delivery

---

## 1. Goal (restated)

An operator-controlled system that (a) runs a durable event-stream and pipeline
substrate, (b) hosts an evolving roster of agent ("BOT") capabilities, and (c) measures
and gates their improvement through a real evaluation harness — surfaced through a
widget and a control-panel dashboard.

## 2. Deliverables (v1)

1. **Widget UI** — operator-facing HUD surface (evolved from prior art in `docs/prior-art/`)
2. **Control-panel dashboard** — live system state; every tile backed by a real data source (no dead buttons, no unlabelled mocks)
3. **Backend pipeline** — L0 durable event log + job runner + artifact store
4. **Evaluation harness** — frozen eval set, paired comparisons, cost/latency telemetry (L3), gated promotion loop (L4)
5. **Docs** — `docs/spec.md`, `docs/plan.md`, ADRs, runbook, STATE journal, CHANGELOG

## 3. Layer scope and proof of done (directive §0.1, binding)

| Layer | Content | Proof of done |
|---|---|---|
| L0 Substrate | Durable event log, state store, job runner, artifact store, observability | Restart mid-job loses nothing; replay is deterministic; backup/restore measured |
| L1 Action | Tool registry with typed contracts, sandboxed workers, connectors | Every tool has a contract test and a documented failure mode |
| L2 Orchestration | Router, task graph, budgets, checkpoints, human gates | A task runs end-to-end unattended within its token/time budget |
| L3 Evaluation | Frozen eval set, regression suite, cost/latency telemetry, adversarial & mutation tests | Scores reproducible across two clean runs, variance reported |
| L4 Improvement | Propose → sandbox-evaluate → paired comparison → gated promotion → rollback | One real promotion with a measured delta and a one-command revert |

**Hard boundary:** the system may propose changes to its own prompts, policies, routing
and tools. It may **never** edit the evaluation set, promotion thresholds, logging, or
gate logic — those are owner-owned and version-frozen.

## 4. Explicit non-goals (v1)

- Toy chatbot
- Dashboards with dead buttons or mock-only data
- Unlabelled synthetic data presented as real (labelled at API response, UI, and docs)
- Unbounded autonomous self-modification
- SaaS billing / multi-tenancy (single-operator security model)
- Feature breadth before the walking skeleton is green

## 5. Security model (v1)

Single primary operator. All external/irreversible actions and all promotions pass a
human gate. Service-to-service auth via `NEXUS_API_TOKEN` (names/scopes in
`ops/secrets.required.yaml`; values never enter chat, commits, or logs — P7).
Secrets are entered by the owner locally; agents see names only via `ops/preflight.py`.

## 6. Environment adaptation — sandbox parity (REQUIRES G0 CONFIRMATION)

This delivery environment is a managed **Next.js 16 + Prisma/SQLite** sandbox: one HTTP
port, **no Docker daemon, no managed Postgres, no managed Redis** in this runtime. The
directive's stack is a hypothesis, not a default; the following adaptations are proposed
for the local-parity milestone, each to be recorded as an ADR with ≥3 alternatives and
an exit path:

| Directive hypothesis | Sandbox parity (proposed) | Delta to manage | Exit path |
|---|---|---|---|
| Postgres (L0 state) | SQLite via Prisma (WAL mode), outbox table | No native consumer groups; offsets implemented in-table | Prisma Postgres provider is a schema-compatible swap |
| Redis Streams (events/jobs) | Durable event table + at-least-once consumer loop with idempotency keys | Polling instead of blocking reads; dedupe owned by us | Swap to Redis Streams client behind the same event-bus interface |
| Containerized workers | In-process job runner (API routes + one Bun mini-service) | No process isolation; budgets enforced in code | Worker interface stays HTTP/queue-shaped for container swap |
| Direct provider keys (Anthropic/OpenAI) | Built-in server-side model gateway | Different model families available for judge diversity | Provider keys stay optional in the manifest; harness is model-agnostic |
| docker-compose parity | Single-repo Next.js app + optional Bun mini-services | No compose file in sandbox | Compose authored in repo, exercised at cloud milestone |

Operator surface constraint in this environment: the widget + dashboard render as a
**single-page control panel at `/`** (views/tabs inside one route); APIs under `/api/*`.
The cloud milestone may split these if desired.

**Cost ceiling:** owner-set per milestone (directive §0). No milestone starts without one.

## 7. Prior art disposition

See `docs/prior-art/README.md`. Carries into v1: improvement-loop shape
(judge → propose → paired comparison → gated promotion → kill-switch), event-schema
instincts, harness-version singleton. Does not carry: Supabase/Deno deployment, browser
userscript delivery, viewer credit economy (parked in `docs/backlog.md`).

## 8. Walking-skeleton definition of done (v1)

One event in → one job → one artifact → one dashboard tile reading **live** data;
restart mid-job loses nothing; synthetic data (if used for UI development) labelled in
API response, UI, and docs; `docs/STATE.md` current; suite + lint clean.

## 9. Open questions resolved at G0

All five questions answered 2026-10-21 — outcomes recorded in §10. Research follow-ups live in `docs/research.md`.

## 10. G0 amendments (owner sign-off, 2026-10-21) — binding additions

**A1 — Sandbox parity stack: ACCEPTED, extended with a connector mandate.** The control
panel is the management plane for the owner's existing live services: **Supabase**
(nexus-cortex edge functions + Postgres tables — the "Brain Cortex"), **Upstash Redis**,
**Hyperbrowser**, and **Kick/stream data**. The panel constructs, monitors and manages
these connections from this sandbox. Port-reach concern resolved by research (see
`docs/research.md` §R3): external SaaS is reached over **egress HTTPS/WSS** (no inbound
ports); sandbox-internal multi-port exists via the gateway (`XTransformPort`); the single
external HTTP port is sufficient for the panel itself.

**A2 — Credential custody: strict.** Secrets for external services live in their own
secret-holding systems (e.g. Supabase Edge Function Secrets / Vault) or are entered by
the owner **locally via the panel's Settings**. The panel may create/modify secrets
("write-style modification") only through the services' own authenticated APIs using
owner-entered credentials. No secret value is ever pasted to chat, logs, or commits (P7
holds). Names/scopes stay in `ops/secrets.required.yaml`.

**A3 — GitHub auth: OAuth2, not PAT.** The panel's Settings gets a modern
**"Connect GitHub"** button using the GitHub OAuth2/App system (GitHub App with
fine-grained, minimal permissions preferred over wide-scope PATs; exact mechanism per
`docs/research.md` §R1 and ADR-003). Owner never hand-copies broad tokens.

**A4 — Operator surface: extensible tabs, not single-page-forever.** The panel is a
long-lived, continuously-improving product: a **tab/view registry architecture** so new
capabilities land as new tabs without rework. In this sandbox all views render under
`/`; the architecture must not depend on that (cloud milestone may split routes).

**A5 — Working cadence: long-run sessions.** Batched, meaningful commits as rollback
points (local now; cloud-side backups once remote exists). Don't stop-and-report after
every doc or file; collaborate with expert subagents (MoE roster); human gates stay
where the directive fixes them (G2 spec, G4 plan, G5 pre-merge, G6 release, promotions,
new directions).

**A6 — M1 walking skeleton: CONFIRMED.** Zero external spend. After ADR-001, M1 = one
event in → one job → one artifact → one live dashboard tile, restart-safe.

**A7 — Supabase agent consult:** owner may loop in their Supabase agent for review at
spec time; not a dependency for Phase 2 drafting.

**A8 — OAuth-first credential acquisition (amends ADR-002/003 practice).** Modern
OAuth 2.0 **click-and-redirect** is the FIRST-choice acquisition pattern for every
credential the panel manages, for every provider that supports it (GitHub App today;
Supabase Mgmt OAuth2 to be verified; Google/other login systems as future sign-in
options). Owner-entered API keys are the documented **fallback only** where a provider
offers no OAuth. Rationale (owner): OAuth removes the setup/rollback/re-setup re-entry
loop for tokens, and short-lived auto-rotating tokens shrink the blast radius of any
accidental push/leak — future users must not inherit a "paste a long-lived key" habit.
Consequence: the panel's Settings UX leads with Connect buttons and treats key entry as
explicit fallback with a warning; NFR for stealth-by-construction (no credential values
in client bundles, responses, or logs).

**A9 — Webshare proxy pool = available egress infrastructure (foundations note).** Owner
operates Webshare: 30 datacenter proxies (US/DE/SE/TR/CH, 250 GB/mo, monthly
auto-refresh, 10 replacements, 500-thread concurrency, high-priority network) + 5 static
residential ($1.50/mo, no auto-refresh) — spend already committed, zero new cost.
**Not used speculatively in M1** (official SaaS APIs need no proxy). Triggered uses,
recorded for foundations: (a) stable egress identity where IP-authorization matters
(sandbox egress IP is not static; a static-residential exit authorized once becomes our
stable caller identity), (b) geo-matched routing (e.g. Istanbul exit), (c) Cloudflare-
gated reads as research fallback, (d) fan-out frontier-watch fetches within 500-thread
budget. The proxy LIST rotates monthly → the panel must fetch it via the **Webshare API**
with owner-entered credentials (no OAuth offered by provider — A8 fallback), never
hardcode IP:port pairs. Proxy addresses pasted in chat are owner-disclosed and are NOT
persisted to the repo (P7 hygiene).

**A10 — Kick scope narrowed (supersedes broader stream ambitions).** Required from
Kick: (1) **stream viewer count**, (2) **`!AI`-triggered bot requests and responses**
only. Channel-level full logs are explicitly out of scope — if hard, we do not need
them. M1 ingestion = the proven userscript capture path posting these two event types
to the panel's ingest API (they land in our L0 log — walking-skeleton input). Official
Kick API (viewer_count via app token) stays a backlog option.
