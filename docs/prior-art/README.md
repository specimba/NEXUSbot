# docs/prior-art/ — NEXUS_BOT prior work inventory

> Evidence for Phase 1 (Grounding). These artifacts predate the v3 directive and are
> reference material only — they do not constrain v1 architecture decisions.

## Provenance

Owner-supplied archive `KICKspeciBOTv1.zip` (43 files, uploaded 2026-10-21) containing
the iteration history of a Kick.com stream chat bot ("Cyber AI HUD Widget") operated on
`kick.com/specimba`, plus a pre-scaffolded `nexus-bootstrap.zip`.

**Secret scan (P7), performed 2026-10-21 before committing:** regex sweep for
JWT/anon-key (`eyJ…`), provider keys (`sk-`, `ghp_`, `AIza`, `xoxb-`, `sb_secret_`)
returned **no matches**. `service_role` mentions occur only as SQL policy discussion,
never as key values. Full archive remains owner-held; only the four files below were
committed. Older widget iterations and chat logs stay out of the repo by size and
noise discipline (recoverable from the owner's archive).

## Committed references

| File | What it is | What it evidences |
|---|---|---|
| `NEXUSbotARCHITECTURE2110a.mermaid` | v30 RSI loop architecture diagram | Generator router → reply → async event log → judge router (cross-family) → JSON evaluation → rule proposal → simulated A/B → gated promotion / logged discard |
| `nexus_v30_supabase_migration.sql` | v30 Supabase (Postgres) schema | 7 tables: `nexus_knowledge`, `nexus_dossiers`, `nexus_stream_events`, `rsi_config` (kill-switch + harness version singleton), `nexus_rsi_evaluations` (score 1–10, failure category, proposed rule), `nexus_persona_rules` (evidence-gated, active flag), `viewer_credits` |
| `kickbot_nexus_os_v30_script.js` | v30.0 userscript (3,273 lines) — current production artifact | Widget engine: HUD telemetry, model switching, RSI trigger every 20 msgs, `!ai rsi kill` kill-switch, banned-topics purge, credit economy |
| `kickbot_nexus_os_v29j_widget.md` | v29.7 widget + deployment spec | Security hardening history: browser-side shared secrets removed, anon-JWT-only calls, server-to-server secrets in edge runtime |

## What carries into NEXUS OS v1 (proposed, pending spec)

- The **improvement loop shape**: log events → judge with a different model family → propose rule → paired comparison → gated activation → kill-switch.
- **Event log schema instincts**: sender, intent, prompt, reply, model label, latency, judged flag.
- **Kill-switch + harness-version singleton** as owner-owned config.
- Security lessons: never ship secrets to the browser; service-to-service auth at the boundary.

## What does NOT carry

- Supabase/Deno deployment model (replaced by ADR-001 decision).
- Browser-embedded userscript delivery (v1 surface is the operator's own control panel).
- Viewer-facing credit economy (parked in `docs/backlog.md`).
