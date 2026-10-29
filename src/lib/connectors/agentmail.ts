import { db } from "@/lib/db";
import { decryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS v37.1 — AgentMail connector: the bot's own email as an agent.
 *
 * Owner paste 2026-10-30 (upload/AGENTMAILautomatedNEWagentSYSTEMSguide3010.txt)
 * + live probes same night. AgentMail is the first email provider built for AI
 * agents: API-first inboxes, first-class threads, webhooks/WebSockets, IMAP/SMTP,
 * per-inbox allow/block lists, pods, and Agent Armor (inbound prompt-injection
 * scanning — Labs, free while in Labs).
 *
 * Honesty ledger [MEASURED 2026-10-30 04:30–05:30 +03, owner's real key]:
 * - `GET  /v0/auth/me`   → 200 {credential_kind:"api_key", credential_scope_type:"organization", …}
 * - `GET  /v0/inboxes`   → 200 {count, inboxes:[{inbox_id (= email), display_name, status_until, …}]}
 * - `GET  /v0/inboxes/{id}/messages?limit=N` → 200 {count, limit, next_page_token,
 *   messages:[{message_id, thread_id, labels, timestamp, from, to[], subject, preview,
 *   agent_armor?{status, verdict, reason, model, completed_at}}]}
 * - `GET  /v0/inboxes/{id}/threads?limit=N`  → 200 {count, threads:[…]}
 * - `POST /v0/inboxes/{id}/messages/send`    → 200 {message_id, thread_id}
 *   (WRONG path `POST …/messages` → 404 not_found; the send verb has its own sub-path.)
 * - `POST /v0/organizations/labs` → 200 {enabled:true} — Agent Armor already on
 *   since 2026-10-29 20:36 UTC; a self-sent probe came back verdict:"clear",
 *   model:"qwen3.8-27b-fp8-choice-v3".
 * - `GET  /v0/organizations/me` → 404 (no such route; org info rides on inboxes).
 * - Error shape: {name:"NotFoundError", code, message, fix, docs} — typed, honest,
 *   always includes a "fix" hint. Surfaced to the panel as-is (no secrets inside).
 *
 * What this connector deliberately does NOT do (docs/agentmail-deep-dive.md §4.2):
 * - No webhook/WebSocket listener yet (needs a deliberate public-URL decision).
 * - No mail→command execution yet: anyone can email the agent inbox; the docs
 *   prescribe Hold mode + sender allowlist + verdict gating first. Read-only + send.
 *
 * Vault layout (service "agentmail"):
 *   label "api"        → webguitest2 Full Access org key (primary)
 *   label "api-backup" → webguitest1 (fallback if the primary is rotated)
 */

export const AGENTMAIL_SERVICE = "agentmail";
export const AGENTMAIL_LABEL = "api";
export const AGENTMAIL_LABEL_BACKUP = "api-backup";
export const AGENTMAIL_BASE = "https://api.agentmail.to";
export const AGENTMAIL_TIMEOUT_MS = 15_000;

/** The panel's agent inbox — fixed by the owner's account (1 of 3 free-tier inboxes). */
export const AGENTMAIL_INBOX_ID = "nexusagent1@agentmail.to";

export type AgentArmor = {
  status: string; // "complete" | "pending" | …
  verdict: string; // "clear" | "review" | …
  reason: string;
  model: string;
  completed_at?: string;
};

export type AgentMailMessage = {
  message_id: string;
  thread_id: string;
  inbox_id: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  agent_armor?: AgentArmor;
};

export type AgentMailInbox = {
  inbox_id: string;
  email: string;
  display_name: string;
  status_until?: string;
  created_at?: string;
};

export type AgentMailStatusPayload = {
  configured: boolean;
  reachable: boolean | null;
  apiOk: boolean | null;
  error: string | null;
  credential: { masked: string; keyId: string; updatedAt: string } | null;
  probedAt: string | null;
  inbox: AgentMailInbox | null;
  labsEnabled: boolean | null;
};

// ---------------------------------------------------------------------------
// Vault access (label fallback: primary → backup)
// ---------------------------------------------------------------------------

export type AgentMailKeyLoad =
  | { ok: true; key: string; masked: string; keyId: string; updatedAt: string; label: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unreadable" };

export async function loadAgentMailKey(): Promise<AgentMailKeyLoad> {
  const rows = await db.credential.findMany({ where: { service: AGENTMAIL_SERVICE } });
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const row = byLabel.get(AGENTMAIL_LABEL) ?? byLabel.get(AGENTMAIL_LABEL_BACKUP);
  if (!row) return { ok: false, reason: "missing" };
  try {
    const key = decryptSecret(row.cipher);
    return {
      ok: true,
      key,
      masked: maskSecret(key),
      keyId: row.keyId,
      updatedAt: row.updatedAt.toISOString(),
      label: row.label,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

// ---------------------------------------------------------------------------
// HTTP core — typed outcomes, never throws across the boundary
// ---------------------------------------------------------------------------

export type AgentMailCall<T> =
  | { ok: true; data: T; tookMs: number }
  | { ok: false; error: string; status: number | null; tookMs: number };

/** Raw fetch against the AgentMail API. Error bodies carry a "fix" field — pass it through. */
async function agentMailCall<T>(
  key: string,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number }
): Promise<AgentMailCall<T>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? AGENTMAIL_TIMEOUT_MS);
  try {
    const res = await fetch(`${AGENTMAIL_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 400) };
    }
    const tookMs = Date.now() - started;
    if (!res.ok) {
      const errBody = parsed as { message?: string; fix?: string; name?: string };
      const parts = [errBody?.name, errBody?.message].filter(Boolean).join(": ");
      const fix = errBody?.fix ? ` (fix: ${errBody.fix})` : "";
      return { ok: false, error: `${parts || `HTTP ${res.status}`}${fix}`, status: res.status, tookMs };
    }
    return { ok: true, data: parsed as T, tookMs };
  } catch (e) {
    const tookMs = Date.now() - started;
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg === "The operation was aborted." ? "timeout" : msg, status: null, tookMs };
  }
}

// ---------------------------------------------------------------------------
// Status probe — auth/me + inboxes + labs in one honest sweep
// ---------------------------------------------------------------------------

export async function probeAgentMail(
  key: string
): Promise<Omit<AgentMailStatusPayload, "configured" | "credential">> {
  const me = await agentMailCall<{ credential_scope_type?: string }>(key, "/v0/auth/me");
  if (!me.ok) {
    return {
      reachable: me.status !== null,
      apiOk: false,
      error: me.error,
      probedAt: new Date().toISOString(),
      inbox: null,
      labsEnabled: null,
    };
  }
  const [inboxes, labs] = await Promise.all([
    agentMailCall<{ count: number; inboxes: AgentMailInbox[] }>(key, "/v0/inboxes"),
    agentMailCall<{ enabled?: boolean }>(key, "/v0/organizations/labs", { method: "POST", body: {} }),
  ]);
  const inbox =
    inboxes.ok
      ? inboxes.data.inboxes.find((i) => i.inbox_id === AGENTMAIL_INBOX_ID) ??
        inboxes.data.inboxes[0] ??
        null
      : null;
  // POST /organizations/labs is idempotent [MEASURED: re-join returns enabled:true]
  const labsEnabled = labs.ok ? labs.data.enabled === true : null;
  return {
    reachable: true,
    apiOk: inboxes.ok,
    error: inboxes.ok ? null : inboxes.error,
    probedAt: new Date().toISOString(),
    inbox,
    labsEnabled,
  };
}

// ---------------------------------------------------------------------------
// Inbox read — latest messages with armor verdicts
// ---------------------------------------------------------------------------

export type AgentMailInboxFeed = {
  count: number;
  messages: Array<{
    messageId: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    preview: string;
    labels: string[];
    timestamp: string;
    armor: { status: string; verdict: string; reason: string } | null;
  }>;
  tookMs: number;
};

export async function listAgentMailInbox(
  key: string,
  limit = 10
): Promise<AgentMailCall<AgentMailInboxFeed>> {
  const capped = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const res = await agentMailCall<{
    count: number;
    messages: AgentMailMessage[];
  }>(key, `/v0/inboxes/${encodeURIComponent(AGENTMAIL_INBOX_ID)}/messages?limit=${capped}`);
  if (!res.ok) return res;
  return {
    ok: true,
    tookMs: res.tookMs,
    data: {
      count: res.data.count,
      tookMs: res.tookMs,
      messages: (res.data.messages ?? []).map((m) => ({
        messageId: m.message_id,
        threadId: m.thread_id,
        from: m.from,
        to: (m.to ?? []).join(", "),
        subject: m.subject ?? "",
        preview: (m.preview ?? "").slice(0, 220),
        labels: m.labels ?? [],
        timestamp: m.timestamp,
        armor: m.agent_armor
          ? {
              status: m.agent_armor.status,
              verdict: m.agent_armor.verdict,
              reason: (m.agent_armor.reason ?? "").slice(0, 200),
            }
          : null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Send — the agent's outbound lane
// ---------------------------------------------------------------------------

export type AgentMailSendResult = {
  messageId: string;
  threadId: string;
  tookMs: number;
};

export async function agentMailSend(
  key: string,
  input: { to: string; subject: string; text: string }
): Promise<AgentMailCall<AgentMailSendResult>> {
  const to = String(input.to ?? "").trim();
  const subject = String(input.subject ?? "").trim().slice(0, 200);
  const text = String(input.text ?? "").trim().slice(0, 4_000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, error: "Invalid recipient address.", status: null, tookMs: 0 };
  }
  if (subject.length < 1 || text.length < 1) {
    return { ok: false, error: "Subject and text are required.", status: null, tookMs: 0 };
  }
  const res = await agentMailCall<{ message_id: string; thread_id: string }>(
    key,
    `/v0/inboxes/${encodeURIComponent(AGENTMAIL_INBOX_ID)}/messages/send`,
    { method: "POST", body: { to, subject, text } }
  );
  if (!res.ok) return res;
  return {
    ok: true,
    tookMs: res.tookMs,
    data: { messageId: res.data.message_id, threadId: res.data.thread_id, tookMs: res.tookMs },
  };
}
