# ADR-001 — Sandbox-parity stack for L0–L2 (SQLite/Prisma substrate, in-process runner)

**Status:** Accepted (G0 sign-off, owner amendments scope §10 A1/A6, 2026-10-21)
**Context:** Directive stack hypothesis (Postgres + Redis Streams + containerized workers)
cannot run in this sandbox: no Docker daemon, no managed Postgres/Redis, one external
HTTP port, egress HTTPS/WSS available. Owner mandate: panel must also reach live
external services (Supabase, Upstash, Hyperbrowser, Kick) — research in
`docs/research.md` R2/R3 confirms egress-only connectivity.

**Options considered:** matrix in `docs/research.md` §Alternatives —
(1) docker-compose Postgres+Redis — rejected: runtime infeasible here;
(2) **SQLite (Prisma, WAL) + durable event table + outbox + in-process runner** — adopted;
(3) Supabase Postgres as primary L0 — rejected for M1 (externalizes substrate; becomes L1 connector/mirror instead);
(4) Upstash REST Streams as primary event bus — rejected for M1 (network latency + quota; L1 connector/mirror instead).

**Decision:** L0 substrate = SQLite via Prisma (WAL) with `events` append-only table,
`outbox` dispatch, consumer offsets in-table, idempotency keys on all writes, artifacts
on disk under `artifacts/` + hashes in DB. Jobs run in-process (Next.js API routes + one
Bun mini-service where isolation is needed). Event-bus access stays behind an interface
so Redis Streams / Postgres swap without touching consumers.

**Consequences:**
- Single-writer discipline required (SQLite WAL: one process writes; mini-service jobs write via API, not direct DB).
- No native consumer groups — offsets + at-least-once dedupe are ours to build (walking-skeleton proof: restart mid-job loses nothing).
- Backup/restore = file copy + verified restore drill (M1 acceptance).
- Exit path: Prisma Postgres provider swap (schema-compatible) + queue swap behind interface.

**Revisit trigger:** cloud milestone; need for >1 writer process; Upstash/Supabase quota pressure.
