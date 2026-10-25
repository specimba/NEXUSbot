# AGENTS.md — NEXUS_BOT / NEXUS OS

Operational instructions for any coding or research agent working in this repository.
**Read order:** `directives/PROJECT_DIRECTIVE.md` (standing orders) → `docs/spec.md` → `docs/plan.md` → `docs/STATE.md` (resume journal) → this file.

If this file and the directive disagree, the directive wins. If code and `docs/spec.md` disagree, the spec wins until it is amended at a gate.

---

## 1. What this repo is

NEXUS OS is an operator-controlled substrate for running, measuring and improving agent systems:
a durable event pipeline (L0), a typed tool/action layer (L1), an orchestrator with budgets and gates (L2),
a frozen evaluation harness (L3), and a gated promotion loop (L4).

Nothing here is a demo. A dashboard tile with no live data source behind it is a **defect**.
Synthetic data must be labelled `synthetic` in the API response, the UI and the docs.

---

## 2. Repository map

```
directives/     standing orders (read-only for agents)
docs/           scope, spec, plan, tasks, research, redteam, security, verify, STATE
docs/decisions/ ADR-*.md — one per irreversible choice
docs/frontier/  monthly frontier watch + rejected variants
ops/            secrets manifest, preflight, vault, bootstrap
backend/        pipeline, workers, API, evaluation harness
web/            widget + control-panel dashboard
tests/          contract, integration, acceptance, regression
```

---

## 3. Commands

> Stack is not frozen yet. Populate this table at ADR-001 and keep it accurate — a wrong command here wastes more time than any other doc rot.

| Task | Command |
|---|---|
| Bootstrap (idempotent) | `./ops/bootstrap.sh` |
| Start local stack | `docker compose up -d` |
| Stop / reset | `docker compose down` / `docker compose down -v` (destructive, owner only) |
| Test (all) | `TBD` |
| Test (single) | `TBD` |
| Lint / format | `TBD` |
| Typecheck | `TBD` |
| Migrate | `TBD` |
| Secret presence check | `python3 ops/preflight.py` |
| Regenerate `.env.example` | `python3 ops/preflight.py --emit-example` |
| Secret scan | `gitleaks detect --no-banner` (pre-commit hook) |

Never invent a command. If a command is unknown, say so and find it in the repo or the ADR.

---

## 4. Non-negotiables

1. **One writer per file.** Parallel agents may read, research, review and test. They may not co-edit.
2. **Contracts before code.** Schemas, API shapes, event payloads and config keys live in `docs/spec.md` and are frozen at a gate before implementation.
3. **No secrets in code, logs, commits, screenshots, fixtures or chat.** Names and scopes only, from `ops/secrets.required.yaml`.
4. **No unlabelled mock.** Label synthetic data at the boundary; never let it reach `main` disguised as production output.
5. **No claim without a tag:** `[VERIFIED]` / `[MEASURED]` / `[INFERRED]` / `[UNVERIFIED]`.
6. **No promotion without a paired, frozen-set measurement** and a human gate.
7. **No `--force` push, no history rewrite** on `main` or any pushed branch.
8. **No new runtime dependency** without an ADR, an exit path and an owner.
9. **No TODO without a ticket ID.** `TODO(T-014): …`

---

## 5. Data and jobs

- Migrations are forward-only in `main`, additive by default, and every migration ships with a tested rollback or an explicit "irreversible — owner approval" note.
- Every write path is **idempotent** on a caller-supplied key; retries are safe by construction.
- Events use the **outbox** pattern; consumers are at-least-once and must dedupe.
- Failed jobs go to a dead-letter queue with the run ID, attempt count and cause. Silent drops are defects.
- Every job has a **budget**: wall-clock, token/cost, and retry ceiling. Exceeding it fails loudly.
- Replays must be deterministic; if they are not, record why in `docs/plan.md`.

---

## 6. Observability contract

Every log line and span carries: `run_id`, `task_id`, `variant` (if any), `layer` (L0–L4), `component`.
Metrics that matter: job latency p50/p95, queue depth, DLQ count, eval score + variance, cost per successful task, promotion/rollback count.

---

## 7. Verification required before any merge to `main`

- [ ] Acceptance criteria (`FR-*`, `NFR-*`) referenced and demonstrated
- [ ] Tests added/updated; full suite green **in a clean environment**
- [ ] Lint + typecheck clean, no new warnings
- [ ] Migration rollback exercised (if schema changed)
- [ ] `gitleaks` clean; `python3 ops/preflight.py` green
- [ ] Docs updated (spec/plan/runbook/CHANGELOG) where behaviour changed
- [ ] `docs/STATE.md` updated with the new last-good commit
- [ ] Independently verified by an agent that did not write the change

---

## 8. Git workflow

- Branches: `feat/<task-id>-<slug>`, `fix/<task-id>-<slug>`, `spike/<slug>` (spike branches are never merged).
- Commits: Conventional Commits, one logical change each, ≤72-char subject, body explains *why*.
- Commit at every task boundary and at least every ~15 minutes of work — the sandbox is ephemeral.
- `main` always runnable. Tags `v0.x` at milestones.
- Push to the private remote at every milestone; if the remote is down, record the pending push in `docs/STATE.md`.

---

## 9. Reporting

Status in ≤200 words: **changed** (paths) · **verified** (command + result) · **learned** · **next** · **needs from owner** (≤3, each with a default).
Never restate the instructions back. Never describe intent as completion.

---

## 10. When to stop and ask

Ask when: requirements conflict; an action is destructive, irreversible or external; a security/privacy trade-off appears; cost would exceed the milestone ceiling; a dependency is unmaintained or licence-incompatible; verification cannot be made independent.

Do not ask about: formatting, test layout, or implementation choices inside frozen contracts — decide, journal it, continue.

---

## 11. Files agents must not touch without explicit instruction

`directives/**` · `docs/decisions/**` (append-only, new ADR per change) · `ops/secrets.required.yaml` (owner-curated) · `.github/workflows/**` · `docs/eval/**` (frozen evaluation set) · anything under `ops/vault/`.
