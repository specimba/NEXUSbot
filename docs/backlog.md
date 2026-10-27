# docs/backlog.md — parking lot (P11)

> New ideas land here with a one-line rationale. Nothing here enters a milestone
> without owner approval at a gate.

| Idea | Source | Rationale for parking |
|---|---|---|
| Viewer credit economy ($5 gift, referral codes, per-image spend ledger) | prior art `viewer_credits` table + v30 script | Viewer-facing product feature; zero value to L0–L4 substrate; revisit after walking skeleton |
| Grok Imagine 2.0 holographic image showcase on stream | v30 script (`!ai çiz` flows) | Stream theatrics; depends on image provider contract (L1) that doesn't exist yet |
| TTS audio bridge (Python local audio) | `nexus_local_audio_bridge_v30.py` | Output-channel concern; needs L1 connector story first; sandbox has no audio surface |
| Webshare proxy pool routes (30 proxies) | `Webshare30proxiesNEXUSproxyROUTES2110.txt` | Scraping infra for connectors (L1); revisit when first connector is specced; secrets handled via manifest |
| Multi-model live switcher (11-model Vyce catalog) | v29–v30 scripts | Model routing belongs to L2 router design; require eval-harness parity before any live switch |
| Cross-session viewer dossiers (banned topics, memory) | `nexus_dossiers` table | Data model decision for spec phase; parked until L0 schema freeze |
| Kick official webhook relay (events → Supabase edge webhook receiver → Postgres → panel) | research R3 (2026-10-21) | Clean egress-only pattern but needs Kick app verification; M1 uses proven userscript→Supabase path instead |
| Unofficial `kick.com/api/v2/*` scraping (VODs, clips, channel JSON) | research R3 (2026-10-21) | Works today (live-probed) but undocumented, Cloudflare-gated, ToS-adjacent — never architecture-critical |
| GitHub installation tokens for unattended automation (1h, JWT-minted) | research R1 / ADR-003 | Requires RSA private key in ADR-002 vault; UAT + refresh covers single-operator v1 |
| Supabase Realtime wss subscription for `nexus_stream_events` | research R2 (medium confidence on new-key compat) | Panel can poll PostgREST for M1; Realtime adds push UX later |
