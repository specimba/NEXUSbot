# ADR-003 — GitHub auth: private GitHub App + Device Flow (no PAT)

**Status:** Accepted (G0 amendments scope §10 A3; research R1, 2026-10-21)
**Context:** Owner explicitly rejected wide-scope PATs and OAuth-App `repo` scope. Panel
preview URL changes across sessions (rules out fixed callback registration). Needs:
push commits to one private repo, create the repo if missing. Single operator.

**Options considered:** see matrix in `docs/research.md` R1 —
(1) Classic PAT / OAuth App (`repo`) — rejected by owner: all-repo access.
(2) Fine-grained PAT — fallback #2: narrow but manually minted/renewed.
(3) **Private GitHub App (owner-registered, installed on ONE repo), Device Flow primary** — adopted.

**Decision:**
- Owner registers a private GitHub App ("only on this account"), permissions:
  **Contents: read/write · Metadata: read · Repository creation: write** (repo creation
  verified to need no Administration:write — R1). Installs it on the single target repo.
- **Device Flow** (enabled in app settings; no callback URL): `POST
  github.com/login/device/code` → owner enters 8-char code at `github.com/login/device`
  → panel polls token endpoint (`slow_down` honored).
- Tokens: UAT `ghu_` 8h + refresh `ghr_` 6mo single-use rotation; refresh scheduled
  before expiry; access/refresh stored encrypted separately (ADR-002 store); optional
  `repository_id` at exchange narrows scope further.
- Settings tab: "Connect GitHub" card → device-code display + status; Disconnect =
  revoke via `DELETE /applications/{client_id}/token`.
- Push via `PUT /repos/{o}/{r}/contents/{path}` / git over `x-access-token:` URL; repo
  creation via `POST /user/repos` (422 → check `GET /repos/{o}/{r}` first).

**Consequences:** owner one-time setup (register app, enable device flow); no callback
URL maintenance ever; expired/revoked token → re-run device flow (UX: status chip in
Settings); client_id is a panel-local credential entry (non-secret, but stored there).

**Revisit trigger:** multi-operator; need for workflow-scoped writes (adds Workflows:write);
if installation-token automation wanted, RSA private key enters ADR-002 vault.
