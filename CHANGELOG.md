# Changelog

All notable changes to NEXUS OS are documented here. Format: Keep-a-Changelog-lite;
versions map to milestone gates. Dates are 2026 sandbox time.

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
