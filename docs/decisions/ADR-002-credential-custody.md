# ADR-002 — Credential custody: panel-local encrypted store + service-native secrets

**Status:** Accepted (G0 amendments scope §10 A2, 2026-10-21)
**Context:** Owner operates live services each with native secret custody (Supabase Edge
Function Secrets/Vault; Upstash tokens; Hyperbrowser keys). Panel must manage connector
credentials ("write-style modification" via the services' own APIs) without any secret
value entering chat, logs, commits, or browser clients (P7). Research (R2): Supabase
Mgmt API `GET /secrets` returns **plaintext** — masking is mandatory; `POST /secrets`
bulk-upserts live without redeploy.

**Options considered:**
(1) All secrets in panel `.env` only — rejected: adding a connector credential needs redeploy; no runtime management.
(2) **Hybrid: panel-local encrypted-at-rest credential store, managed via Settings tab (write-only UI), used server-side only; service-native custody preserved** (Supabase secrets managed via Mgmt API with owner-entered scoped PAT) — adopted.
(3) Centralize everything in Supabase Vault, panel reads via service key — rejected: circular custody (panel needs a Supabase secret before it can read the vault), and Beta `/database/query` path not architecture-grade.

**Decision:**
- Panel-local store: `credentials` table, value encrypted with `ENCRYPTION_KEY` (key-id versioned per manifest), name/scope/status in plaintext for UI.
- Settings tab: create/update **write-only** (values never rendered back, never logged; audit = name + timestamp + actor only).
- Supabase edge secrets: panel writes via `POST /v1/projects/{ref}/secrets` using owner-entered scoped Mgmt PAT; `GET /secrets` used only for existence/status, values masked and never persisted.
- `ops/secrets.required.yaml` remains the name/scope manifest (owner-curated); panel credentials are named per-connector and added to the manifest at spec gate.

**Consequences:** ENCRYPTION_KEY becomes load-bearing (rotation procedure = re-encrypt sweep, documented in runbook); UI masking is a functional requirement; audit trail records metadata only.

**Revisit trigger:** multi-operator; cross-service credential sharing; Supabase Mgmt OAuth2 flow if PAT scope feels too broad.
