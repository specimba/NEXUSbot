import { db } from "@/lib/db";
import { decryptSecret, maskSecret } from "@/lib/crypto";
import { readFileSync } from "node:fs";

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

// ---------------------------------------------------------------------------
// v37.3 — Threads (the promised "send/list/threads/armor" surface, §4.3)
// ---------------------------------------------------------------------------

/** Thread rows are mapped defensively: the list shape carries thread_id plus
 * a subset of latest-message fields depending on API version. */
export type AgentMailThread = {
  threadId: string;
  subject: string;
  preview: string;
  senders: string[];
  recipients: string[];
  labels: string[];
  messageCount: number | null;
  latestTimestamp: string | null;
};

export type AgentMailThreadFeed = {
  count: number;
  threads: AgentMailThread[];
  tookMs: number;
};

type RawThread = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export async function listAgentMailThreads(
  key: string,
  limit = 10
): Promise<AgentMailCall<AgentMailThreadFeed>> {
  const capped = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const res = await agentMailCall<{ count: number; threads: RawThread[] }>(
    key,
    `/v0/inboxes/${encodeURIComponent(AGENTMAIL_INBOX_ID)}/threads?limit=${capped}`
  );
  if (!res.ok) return res;
  const threads = (res.data.threads ?? []).map((t) => ({
    threadId: str(t.thread_id),
    subject: str(t.latest_message_subject) || str(t.subject),
    preview: (str(t.preview) || str(t.latest_message_preview)).slice(0, 200),
    senders: strArray(t.senders),
    recipients: strArray(t.recipients),
    labels: strArray(t.labels),
    messageCount: typeof t.message_count === "number" ? t.message_count : null,
    latestTimestamp: str(t.latest_message_timestamp) || str(t.timestamp) || null,
  }));
  return { ok: true, tookMs: res.tookMs, data: { count: res.data.count, threads, tookMs: res.tookMs } };
}

// ---------------------------------------------------------------------------
// v37.3 — Daily digest (docs/agentmail-deep-dive.md §7.3)
//   cron 06:00 Istanbul → nexusagent1 → owner email: yesterday's stats.
//   Builder is DB+fs only (no AgentMail calls) so previews are free.
// ---------------------------------------------------------------------------

/** Owner's address — the AgentMail org account email (specimba@gmail.com).
 * Replies + digests go here; the command lane allowlist is exactly this. */
export const AGENTMAIL_OWNER_EMAIL = "specimba@gmail.com";

/** Europe/Istanbul is fixed UTC+3 (no DST since 2016). */
const IST_OFFSET_MS = 3 * 60 * 60 * 1000;

export type IstDayRange = { startUtc: Date; endUtc: Date; label: string };

/** Day window for the Istanbul calendar day containing `nowMs`. */
export function istanbulDay(nowMs = Date.now()): IstDayRange {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const startMs = Date.UTC(y, m, d) - IST_OFFSET_MS;
  const endMs = Date.UTC(y, m, d + 1) - IST_OFFSET_MS;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    startUtc: new Date(startMs),
    endUtc: new Date(endMs),
    label: `${y}-${pad(m + 1)}-${pad(d)}`,
  };
}

export type AgentMailDigest = {
  dateLabel: string;
  builtAt: string;
  interactions: {
    total: number;
    ok: number;
    error: number;
    webUsed: number;
    uniqueViewers: number;
    avgLatencyMs: number | null;
    topViewers: Array<{ username: string; count: number }>;
    topModels: Array<{ model: string; count: number }>;
  };
  llm: { calls: number; topModels: Array<{ model: string; count: number }> } | null;
  image: { credits: number; count: number } | null;
  vault: { credentials: number };
  backup: { lastResult: string; lastAt: string; head: string } | null;
  subject: string;
  text: string;
};

/** Aggregate one Istanbul day into the honest digest body (DB + fs only). */
export async function buildAgentMailDigest(day: IstDayRange): Promise<AgentMailDigest> {
  const since = day.startUtc;
  const until = day.endUtc;

  const [total, okRows, uniqueViewers, webUsed, lat, topViewers, topModels] = await Promise.all([
    db.interactionLog.count({ where: { createdAt: { gte: since, lt: until } } }),
    db.interactionLog.count({ where: { createdAt: { gte: since, lt: until }, status: "ok" } }),
    db.interactionLog.groupBy({
      by: ["username"],
      where: { createdAt: { gte: since, lt: until } },
      _count: { _all: true },
    }),
    db.interactionLog.count({ where: { createdAt: { gte: since, lt: until }, webUsed: true } }),
    db.interactionLog.aggregate({
      where: { createdAt: { gte: since, lt: until }, latencyMs: { not: null } },
      _avg: { latencyMs: true },
    }),
    db.interactionLog.groupBy({
      by: ["username"],
      where: { createdAt: { gte: since, lt: until } },
      _count: { _all: true },
      orderBy: { _count: { username: "desc" } },
      take: 5,
    }),
    db.interactionLog.groupBy({
      by: ["model"],
      where: { createdAt: { gte: since, lt: until } },
      _count: { _all: true },
      orderBy: { _count: { model: "desc" } },
      take: 5,
    }),
  ]);

  const viewers = uniqueViewers.length;
  const avgLatency = lat._avg.latencyMs ? Math.round(lat._avg.latencyMs) : null;

  // Usage lane — the live Prisma client carries UsageEvent (additive push); a
  // stale dev-server process answers honestly with null instead of guessing.
  let llm: AgentMailDigest["llm"] = null;
  let image: AgentMailDigest["image"] = null;
  if ("usageEvent" in db) {
    const pdb = db as unknown as {
      usageEvent: {
        count: (a: unknown) => Promise<number>;
        aggregate: (a: unknown) => Promise<{ _sum: { credits: number | null } }>;
        groupBy: (a: unknown) => Promise<Array<{ model: string; _count: { _all: number } }>>;
      };
    };
    const where = { ts: { gte: since, lt: until } };
    const [llmCalls, llmByModel, imgAgg, imgCount] = await Promise.all([
      pdb.usageEvent.count({ where: { ...where, kind: "llm" } }),
      pdb.usageEvent.groupBy({
        by: ["model"],
        where: { ...where, kind: "llm" },
        _count: { _all: true },
      }),
      pdb.usageEvent.aggregate({ where: { ...where, kind: "image" }, _sum: { credits: true } }),
      pdb.usageEvent.count({ where: { ...where, kind: "image" } }),
    ]);
    llm = {
      calls: llmCalls,
      topModels: llmByModel
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 4)
        .map((r) => ({ model: r.model, count: r._count._all })),
    };
    image = { credits: imgAgg._sum.credits ?? 0, count: imgCount };
  }

  const credentials = await db.credential.count();

  // Backup state (.zscripts/backup-state.json — written by the backup script,
  // never contains secrets). Missing file → honest null.
  let backup: AgentMailDigest["backup"] = null;
  try {
    const raw = JSON.parse(readFileSync(".zscripts/backup-state.json", "utf8")) as {
      lastResult?: string;
      lastAt?: string;
      head?: string;
    };
    if (raw.lastResult) {
      backup = {
        lastResult: raw.lastResult,
        lastAt: raw.lastAt ?? "",
        head: (raw.head ?? "").slice(0, 12),
      };
    }
  } catch {
    backup = null;
  }

  const fmtUsers = topViewers.map((r) => `${r.username}×${r._count._all}`).join(", ") || "—";
  const fmtModels = topModels.map((r) => `${r.model || "?"}×${r._count._all}`).join(", ") || "—";

  const lines = [
    `NEXUS OS daily digest — ${day.label} (Europe/Istanbul)`,
    ``,
    `Chat lane (last calendar day):`,
    `  interactions: ${total} · ok ${okRows} / error ${total - okRows} · unique viewers: ${viewers}`,
    `  web research runs: ${webUsed}${avgLatency !== null ? ` · avg latency: ${avgLatency}ms` : ""}`,
    `  top models: ${fmtModels}`,
    `  top viewers: ${fmtUsers}`,
    ``,
    `LLM lane: ${llm ? `${llm.calls} calls (top: ${llm.topModels.map((m) => `${m.model}×${m.count}`).join(", ") || "—"})` : "usage table unavailable in this server process"}`,
    `Image lane: ${image ? `${image.credits} credits across ${image.count} creations` : "usage table unavailable in this server process"}`,
    ``,
    `Durability: backup last=${backup ? `${backup.lastResult} at ${backup.lastAt} (head ${backup.head})` : "state unavailable"}`,
    `Vault: ${credentials} credentials`,
    `Web lanes: Exa primary · Keenable free · TinyFish free · Firecrawl metered`,
    ``,
    `— NEXUS OS · nexusagent1@agentmail.to · auto-generated daily digest`,
  ];

  return {
    dateLabel: day.label,
    builtAt: new Date().toISOString(),
    interactions: {
      total,
      ok: okRows,
      error: total - okRows,
      webUsed,
      uniqueViewers: viewers,
      avgLatencyMs: avgLatency,
      topViewers: topViewers.map((r) => ({ username: r.username, count: r._count._all })),
      topModels: topModels.map((r) => ({ model: r.model, count: r._count._all })),
    },
    llm,
    image,
    vault: { credentials },
    backup,
    subject: `NEXUS OS daily digest — ${day.label}`,
    text: lines.join("\n").slice(0, 4_000),
  };
}

/** Build + send the digest for yesterday (Istanbul) to the owner. */
export async function sendDailyDigest(
  key: string
): Promise<AgentMailCall<{ digest: AgentMailDigest; sent: AgentMailSendResult }>> {
  const digest = await buildAgentMailDigest(istanbulDay(Date.now() - 24 * 60 * 60 * 1000));
  const res = await agentMailSend(key, {
    to: AGENTMAIL_OWNER_EMAIL,
    subject: digest.subject,
    text: digest.text,
  });
  if (!res.ok) return { ok: false, error: res.error, status: res.status, tookMs: res.tookMs };
  return { ok: true, tookMs: res.tookMs, data: { digest, sent: res.data } };
}

// ---------------------------------------------------------------------------
// v37.3 — Mail→bot command lane (P3, docs/agentmail-deep-dive.md §4.2 design)
//
// Pull-based (no webhook needed — §7.2 stays parked). Triple gate before ANY
// execution, per the platform docs' prescription:
//   1. SENDER: exactly the owner allowlist (AGENTMAIL_OWNER_EMAIL).
//   2. ARMOR:  agent_armor.verdict === "clear" ("review"/"unavailable" → skip,
//      exactly how the docs tell listing agents to treat held/unavailable mail).
//   3. COMMAND: subject must match a strict whitelist — no LLM, no free-text
//      interpretation, no injection surface. Body is never parsed.
// Replies ride the send lane. Cursor (Setting) = latest final-verdict message
// timestamp seen; owner messages still armor-"pending" stay behind the cursor
// and are re-examined next poll (scans finish in seconds; "unavailable" is a
// terminal non-clear verdict and advances past).
// ---------------------------------------------------------------------------

export type AgentMailCommandName = "help" | "status" | "digest" | "ping" | "uptime";

const COMMAND_RE = /^(?:nexus\s+)?(help|status|digest|ping|uptime)[.!\s]*$/i;
const COMMANDS_CURSOR_KEY = "agentmail.commands.cursor";

/** From can carry a display name ("Name <a@b>") — extract the bare address. */
function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export type AgentMailCommandOutcome = {
  messageId: string;
  from: string;
  subject: string;
  command: AgentMailCommandName;
  replySubject: string;
  replySent: boolean;
  replyError: string | null;
};

export type AgentMailCommandPollResult = {
  ok: true;
  scanned: number;
  cursor: string;
  processed: AgentMailCommandOutcome[];
  skipped: { notOwner: number; armorNotClear: number; noCommand: number; old: number; pending: number };
};

export async function pollAgentMailCommands(
  key: string,
  opts: { dryRun?: boolean; limit?: number } = {}
): Promise<AgentMailCall<AgentMailCommandPollResult>> {
  const limit = Math.max(10, Math.min(50, opts.limit ?? 25));
  const feed = await listAgentMailInbox(key, limit);
  if (!feed.ok) return feed;

  // Cursor: Setting-stored ISO timestamp. Absent → now: mail that predates the
  // feature is NEVER auto-executed (deliberate — old mail is read, not run).
  const cursorRow = await db.setting.findUnique({ where: { key: COMMANDS_CURSOR_KEY } });
  const prevCursor = cursorRow?.value ?? new Date().toISOString();

  const skipped = { notOwner: 0, armorNotClear: 0, noCommand: 0, old: 0, pending: 0 };
  const processed: AgentMailCommandOutcome[] = [];
  let newCursor = prevCursor;

  // Feed is latest-first; walk chronological so a digest command's own reply
  // (which we send below) never lands inside this poll's set.
  for (const m of [...feed.data.messages].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))) {
    const ts = m.timestamp || "";
    const isOwner = senderAddress(m.from) === AGENTMAIL_OWNER_EMAIL;
    const pending = isOwner && m.armor?.status === "pending";
    if (pending) {
      skipped.pending += 1;
      continue; // stays behind the cursor — re-examined next poll
    }
    if (ts && ts > newCursor) newCursor = ts; // advance past every FINAL state
    if (!ts || ts <= prevCursor) {
      skipped.old += 1;
      continue;
    }
    if (!isOwner) {
      skipped.notOwner += 1;
      continue;
    }
    if (m.armor?.verdict !== "clear") {
      skipped.armorNotClear += 1;
      continue;
    }
    const match = m.subject.trim().match(COMMAND_RE);
    if (!match) {
      skipped.noCommand += 1;
      continue;
    }
    const command = match[1].toLowerCase() as AgentMailCommandName;

    let replyText: string;
    let replySubject: string;
    if (command === "help") {
      replySubject = "NEXUS — commands";
      replyText = [
        `NEXUS OS mail-command lane — available commands (email subject line):`,
        ``,
        `  help    — this list`,
        `  status  — last-24h system status (chat/LLM/durability/vault)`,
        `  digest  — build + send yesterday's digest immediately`,
        `  ping    — liveness check`,
        `  uptime  — same as ping`,
        ``,
        `Gates: sender=${AGENTMAIL_OWNER_EMAIL} · Agent Armor verdict must be "clear" · strict subject whitelist.`,
        `— NEXUS OS · nexusagent1@agentmail.to`,
      ].join("\n");
    } else if (command === "status") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [inter, okRows, webUsed, credentials] = await Promise.all([
        db.interactionLog.count({ where: { createdAt: { gte: since } } }),
        db.interactionLog.count({ where: { createdAt: { gte: since }, status: "ok" } }),
        db.interactionLog.count({ where: { createdAt: { gte: since }, webUsed: true } }),
        db.credential.count(),
      ]);
      let backupLine = "durability: state unavailable";
      try {
        const raw = JSON.parse(readFileSync(".zscripts/backup-state.json", "utf8")) as {
          lastResult?: string;
          lastAt?: string;
        };
        if (raw.lastResult) backupLine = `durability: backup last=${raw.lastResult} at ${raw.lastAt}`;
      } catch {
        /* honest default above */
      }
      replySubject = "NEXUS — status";
      replyText = [
        `NEXUS OS status (last 24h):`,
        ``,
        `  chat interactions: ${inter} (ok ${okRows} / error ${inter - okRows})`,
        `  web research runs: ${webUsed}`,
        `  vault: ${credentials} credentials`,
        `  ${backupLine}`,
        `  lanes: Exa primary · Keenable free · TinyFish free · Firecrawl metered`,
        ``,
        `— NEXUS OS · nexusagent1@agentmail.to`,
      ].join("\n");
    } else if (command === "digest") {
      const sent = await sendDailyDigest(key);
      replySubject = sent.ok ? "NEXUS — digest sent" : "NEXUS — digest FAILED";
      replyText = sent.ok
        ? `Digest for ${sent.data.digest.dateLabel} sent to ${AGENTMAIL_OWNER_EMAIL}.\n\nPreview:\n${sent.data.digest.text.slice(0, 600)}`
        : `Digest build/send failed: ${sent.error}`;
    } else {
      replySubject = "NEXUS — alive";
      replyText = `pong — NEXUS OS mail lane alive at ${new Date().toISOString()} (Istanbul ${new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(11, 16)}).`;
    }

    let replySent = false;
    let replyError: string | null = null;
    if (!opts.dryRun) {
      const reply = await agentMailSend(key, { to: AGENTMAIL_OWNER_EMAIL, subject: replySubject, text: replyText });
      replySent = reply.ok;
      replyError = reply.ok ? null : reply.error;
    }
    processed.push({ messageId: m.messageId, from: m.from, subject: m.subject, command, replySubject, replySent, replyError });
  }

  if (!opts.dryRun && newCursor !== prevCursor) {
    await db.setting.upsert({
      where: { key: COMMANDS_CURSOR_KEY },
      create: { key: COMMANDS_CURSOR_KEY, value: newCursor },
      update: { value: newCursor },
    });
  }

  return {
    ok: true,
    tookMs: feed.tookMs,
    data: { ok: true as const, scanned: feed.data.messages.length, cursor: newCursor, processed, skipped },
  };
}
