import crypto from "node:crypto";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";

/**
 * NEXUS OS — Kick official connection (Task 30).
 *
 * The panel ALREADY reads live Kick chat anonymously (mini-services/kick-bridge,
 * port 3010 — viewer-grade Centrifuge socket → widgets). This connector is the
 * missing WRITE half the owner asked for ("why we are not making that kick
 * connection still?"): the official OAuth 2.1 app connection so VYCE can post
 * replies INTO the live chat as a bot and receive signed webhooks.
 *
 * GROUND TRUTH (docs.kick.com, pulled 2026-10-27 via /llms.txt markdown):
 *   - OAuth 2.1 + PKCE S256 on https://id.kick.com
 *     · authorize: GET /oauth/authorize?response_type=code&client_id&redirect_uri
 *                  &scope&state&code_challenge&code_challenge_method=S256
 *     · token:     POST /oauth/token  (application/x-www-form-urlencoded!)
 *                  grant_type=authorization_code|refresh_token|client_credentials
 *     · refresh ROTATES the refresh token — every refresh persists the new pair
 *     · revoke:    POST /oauth/revoke?token=…&token_hint_type=refresh_token
 *   - API on https://api.kick.com/public/v1 (Bearer)
 *     · GET  /users            → authorized user (user_id, name)
 *     · POST /chat             → {content ≤500 graphemes, type: "user"|"bot"}
 *       As type:"bot" the message goes to the channel attached to the token —
 *       no broadcaster_user_id needed.
 *     · GET/POST/DELETE /events/subscriptions → webhook feed control
 *       POST body {events:[{name, version}], method:"webhook"}
 *   - Webhooks are RSA-signed (NOT HMAC): GET /public/v1/public-key (PEM,
 *     may rotate — never hardcode), signature header Kick-Event-Signature =
 *     base64(RSA PKCS1v15-SHA256(`${Kick-Event-Message-Id}.${Kick-Event-Timestamp}.${rawBody}`))
 *     Kick unsubscribes an app whose webhook keeps failing for a day → the
 *     ingest route always answers 200 after signature validation.
 *
 * Vault layout (service "kick"):
 *   label "app"   → JSON {clientId, clientSecret}
 *   label "oauth" → JSON {accessToken, refreshToken, expiresAt, scope,
 *                          account:{userId,name}, savedAt}
 *
 * Runtime state lives on globalThis (the v29.20 lesson: Next dev Turbopack
 * instantiates separate module instances per route compilation — cross-route
 * in-memory state MUST be process-wide, not module-wide).
 */

export const KICK_SERVICE = "kick";
const APP_LABEL = "app";
const OAUTH_LABEL = "oauth";

export const KICK_OAUTH_HOST = "https://id.kick.com";
export const KICK_API_HOST = "https://api.kick.com";

/** Minimal scope set for the bot use-case (subset of the app's granted scopes). */
export const KICK_SCOPES = ["user:read", "channel:read", "chat:write", "events:subscribe"] as const;
export const KICK_SCOPE_HINTS: Record<string, string> = {
  "user:read": "Read user information (including email address)",
  "channel:read": "Read channel information",
  "chat:write": "Write to Chat feed",
  "events:subscribe": "Subscribe to events (read chat feed, follows, subscribes, gifts)",
};
export const KICK_WEBHOOK_EVENTS = [{ name: "chat.message.sent", version: 1 }] as const;

const TOKEN_TTL_MARGIN_MS = 60_000; // refresh a minute before expiry
const PKCE_TTL_MS = 10 * 60_000;
const PUBLIC_KEY_TTL_MS = 60 * 60_000;
const CHAT_SEND_GAP_MS = 1_500; // polite floor between bot posts
const HTTP_TIMEOUT_MS = 15_000;

export type KickApp = { clientId: string; clientSecret: string };

export type KickOAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  account?: { userId: number; name: string };
  savedAt: number;
};

export type KickWebhookSub = { id: string; event: string; version: number };

// ---------------------------------------------------------------------------
// Runtime store (process-wide)
// ---------------------------------------------------------------------------

type KickRuntime = {
  /** Single-flight token refresh (rotation means concurrent refreshes kill the pair). */
  refreshInFlight: Promise<KickOAuth> | null;
  /** state → {verifier, redirectUri} for the in-flight authorization round-trip. */
  pkce: Map<string, { verifier: string; redirectUri: string; createdAt: number }>;
  /** Cached Kick RSA public key (PEM) — docs: never hardcode, may rotate. */
  publicKey: { pem: string | null; fetchedAt: number } | null;
  /** Idempotency for webhook deliveries (Kick-Event-Message-Id LRU). */
  seenEventIds: Map<string, number>;
  lastChatSentAt: number;
  /** Serialized bot-send queue so bursts never violate the gap. */
  sendChain: Promise<unknown>;
};

const g = globalThis as typeof globalThis & { __nexusKickRuntime?: KickRuntime };
const rt: KickRuntime =
  g.__nexusKickRuntime ??
  (g.__nexusKickRuntime = {
    refreshInFlight: null,
    pkce: new Map(),
    publicKey: null,
    seenEventIds: new Map(),
    lastChatSentAt: 0,
    sendChain: Promise.resolve(),
  });

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export async function loadKickApp(): Promise<KickApp | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: KICK_SERVICE, label: APP_LABEL } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(decryptSecret(row.cipher)) as Partial<KickApp>;
    if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string") {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveKickApp(app: KickApp): Promise<void> {
  const { keyId, cipher } = encryptSecret(JSON.stringify(app));
  await db.credential.upsert({
    where: { service_label: { service: KICK_SERVICE, label: APP_LABEL } },
    create: { service: KICK_SERVICE, label: APP_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function loadKickOAuth(): Promise<KickOAuth | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: KICK_SERVICE, label: OAUTH_LABEL } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(decryptSecret(row.cipher)) as Partial<KickOAuth>;
    if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string") {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: Number(parsed.expiresAt) || 0,
        scope: String(parsed.scope ?? ""),
        account:
          parsed.account && typeof parsed.account.userId === "number" && typeof parsed.account.name === "string"
            ? parsed.account
            : undefined,
        savedAt: Number(parsed.savedAt) || Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveKickOAuth(oauth: KickOAuth): Promise<void> {
  const { keyId, cipher } = encryptSecret(JSON.stringify(oauth));
  await db.credential.upsert({
    where: { service_label: { service: KICK_SERVICE, label: OAUTH_LABEL } },
    create: { service: KICK_SERVICE, label: OAUTH_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function deleteKickOAuth(): Promise<void> {
  await db.credential.deleteMany({ where: { service: KICK_SERVICE, label: OAUTH_LABEL } });
}

/** Wipes the whole Kick vault config (app + oauth). Idempotent. */
export async function deleteKickConfig(): Promise<number> {
  const res = await db.credential.deleteMany({ where: { service: KICK_SERVICE } });
  return res.count;
}

export function maskKickApp(app: KickApp): { clientIdMasked: string; clientSecretMasked: string } {
  return { clientIdMasked: maskSecret(app.clientId), clientSecretMasked: maskSecret(app.clientSecret) };
}

// ---------------------------------------------------------------------------
// Settings (chat-replies toggle)
// ---------------------------------------------------------------------------

const CHAT_REPLIES_KEY = "kick.chatReplies";

export async function getKickChatReplies(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: CHAT_REPLIES_KEY } });
  return row ? row.value === "on" : true; // default ON: the connection's purpose
}

export async function setKickChatReplies(on: boolean): Promise<void> {
  await db.setting.upsert({
    where: { key: CHAT_REPLIES_KEY },
    create: { key: CHAT_REPLIES_KEY, value: on ? "on" : "off" },
    update: { value: on ? "on" : "off" },
  });
}

// ---------------------------------------------------------------------------
// PKCE + authorize URL + state mint
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars — within RFC 7636's 43–128
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function kickCallbackUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/kick/callback`;
}

/** Exact URL to paste into the Kick Create-an-App "Enable webhooks" field. */
export function kickWebhookUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/kick/webhook`;
}

/** Public origin of an incoming panel request (behind the Caddy gateway). */
export function requestOrigin(req: Request): string {
  const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0].trim() || "http";
  const host =
    (req.headers.get("x-forwarded-host") ?? "").split(",")[0].trim() || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

/**
 * v31 — PUBLIC-ORIGIN TRUTH for everything the OUTSIDE world must reach
 * (Kick redirect_uri, webhook subscription URL, post-auth browser redirect).
 *
 * Behind the Z.ai preview gateway the request-derived origin is the FC
 * TUNNEL host with http scheme (measured live 05:3x +03: /api/kick/status
 * through https://preview-chat-…space-z.ai still computed
 * http://ws-ef-…fcapp.run/api/kick/callback — exactly the URL the owner
 * pasted into Kick's Create-an-App form, which Kick rejected for scheme and
 * which would ALSO have failed the FC session-affinity gate on both the
 * browser redirect and Kick's webhook POSTs).
 *
 * The owner-anchored OBS base URL on the widget row is the REAL
 * browser-reachable https origin — it is literally the URL the OBS overlay
 * loads the panel through. Prefer it whenever it exists and is https;
 * otherwise fall back to the request-derived origin (dev / direct access).
 */
export async function publicOrigin(req: Request): Promise<string> {
  try {
    const w = await db.widget.findFirst({
      where: { obsBaseUrl: { not: null } },
      select: { obsBaseUrl: true },
    });
    const anchored = (w?.obsBaseUrl ?? "").trim();
    if (anchored && /^https:\/\//i.test(anchored)) {
      return anchored.replace(/\/+$/, "");
    }
  } catch {
    // db unavailable (fresh boot) — fall through to request-derived
  }
  return requestOrigin(req);
}

/**
 * Mints a one-time {state → verifier, redirectUri} record and returns the
 * full authorize URL. The verifier NEVER leaves the server — it is only spent
 * by the callback (single-use, 10-min TTL, cap 50).
 */
export function mintKickAuth(app: KickApp, redirectUri: string): { authorizeUrl: string } {
  const state = b64url(crypto.randomBytes(24));
  const { verifier, challenge } = makePkce();
  // Prune expired/capped entries.
  const now = Date.now();
  for (const [k, v] of rt.pkce) {
    if (now - v.createdAt > PKCE_TTL_MS) rt.pkce.delete(k);
  }
  while (rt.pkce.size >= 50) {
    const oldest = rt.pkce.keys().next().value;
    if (oldest === undefined) break;
    rt.pkce.delete(oldest);
  }
  rt.pkce.set(state, { verifier, redirectUri, createdAt: now });

  const u = new URL(`${KICK_OAUTH_HOST}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", app.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", KICK_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: u.toString() };
}

/** Consumes a minted state (single-use). Returns null when unknown/expired. */
export function spendKickAuth(state: string): { verifier: string; redirectUri: string } | null {
  const rec = rt.pkce.get(state);
  if (!rec) return null;
  rt.pkce.delete(state);
  if (Date.now() - rec.createdAt > PKCE_TTL_MS) return null;
  return { verifier: rec.verifier, redirectUri: rec.redirectUri };
}

// ---------------------------------------------------------------------------
// OAuth token endpoint (form-urlencoded per docs)
// ---------------------------------------------------------------------------

type KickTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
};

async function kickTokenRequest(form: Record<string, string>): Promise<KickTokenResponse> {
  const res = await fetch(`${KICK_OAUTH_HOST}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: KickTokenResponse | null = null;
  try {
    body = JSON.parse(text) as KickTokenResponse;
  } catch {
    /* fallthrough to status error */
  }
  if (!res.ok) {
    const code = body?.error ?? `HTTP_${res.status}`;
    throw new Error(code);
  }
  if (!body?.access_token) throw new Error("token response missing access_token");
  return body;
}

function oauthFromTokenResponse(t: KickTokenResponse, prev?: KickOAuth): KickOAuth {
  const expiresInMs = Math.max(60, Number(t.expires_in) || 300) * 1_000;
  return {
    accessToken: t.access_token,
    // Docs: refresh ROTATES — if a refresh response omits refresh_token, keep
    // the previous one rather than writing an unusable null pair.
    refreshToken: t.refresh_token ?? prev?.refreshToken ?? "",
    expiresAt: Date.now() + Math.min(expiresInMs - TOKEN_TTL_MARGIN_MS, expiresInMs),
    scope: String(t.scope ?? prev?.scope ?? KICK_SCOPES.join(" ")),
    account: prev?.account,
    savedAt: Date.now(),
  };
}

export async function exchangeKickCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  app: KickApp;
}): Promise<KickOAuth> {
  const t = await kickTokenRequest({
    grant_type: "authorization_code",
    client_id: opts.app.clientId,
    client_secret: opts.app.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    code: opts.code,
  });
  return oauthFromTokenResponse(t);
}

/**
 * Refresh with rotation, single-flight. Concurrent callers share one HTTP
 * round-trip — a second parallel refresh would burn the just-rotated token.
 */
export async function refreshKickOAuth(force = false): Promise<KickOAuth> {
  const current = await loadKickOAuth();
  if (!current) throw new Error("not connected");
  if (!force && Date.now() < current.expiresAt - TOKEN_TTL_MARGIN_MS) return current;
  if (rt.refreshInFlight) return rt.refreshInFlight;

  const app = await loadKickApp();
  if (!app) throw new Error("app credentials missing");
  if (!current.refreshToken) throw new Error("no refresh token stored");

  const flight = (async () => {
    const t = await kickTokenRequest({
      grant_type: "refresh_token",
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: current.refreshToken,
    });
    const next = oauthFromTokenResponse(t, current);
    await saveKickOAuth(next); // persist rotation IMMEDIATELY (single-use tokens)
    return next;
  })();

  rt.refreshInFlight = flight;
  try {
    return await flight;
  } finally {
    rt.refreshInFlight = null;
  }
}

/** Best-effort revoke on disconnect — failures must not block the wipe. */
export async function revokeKickTokens(): Promise<void> {
  const oauth = await loadKickOAuth();
  const app = await loadKickApp();
  if (!oauth || !app) return;
  for (const [token, hint] of [
    [oauth.refreshToken, "refresh_token"],
    [oauth.accessToken, "access_token"],
  ] as const) {
    if (!token) continue;
    try {
      const u = new URL(`${KICK_OAUTH_HOST}/oauth/revoke`);
      u.searchParams.set("token", token);
      u.searchParams.set("token_hint_type", hint);
      await fetch(u.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      /* revocation is best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Public API calls (Bearer + auto-refresh once on 401)
// ---------------------------------------------------------------------------

export type KickApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string };

async function kickApiFetch(path: string, init: RequestInit, allowRefresh = true): Promise<Response> {
  const oauth = await refreshKickOAuth(); // no-op when fresh
  const res = await fetch(`${KICK_API_HOST}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${oauth.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 401 && allowRefresh) {
    await refreshKickOAuth(true); // force one rotation
    return kickApiFetch(path, init, false);
  }
  return res;
}

/** GET /public/v1/users → the authorized user (or null when the call fails). */
export async function getKickUser(): Promise<{ userId: number; name: string } | null> {
  try {
    const res = await kickApiFetch("/public/v1/users", { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ user_id?: number; name?: string }> };
    const me = body.data?.[0];
    if (typeof me?.user_id === "number" && typeof me.name === "string") {
      return { userId: me.user_id, name: me.name };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Post a bot chat message. type:"bot" → sent to the channel attached to the
 * token. Content clamped to ≤480 graphemes / ≤2000 UTF-8 bytes (docs limits:
 * 500 / 2048). Serialized with a 1.5s floor so bursts stay polite.
 */
export async function kickSendBotMessage(content: string): Promise<{ ok: boolean; code?: string; messageId?: string }> {
  const oauth = await loadKickOAuth();
  if (!oauth) return { ok: false, code: "NOT_CONNECTED" };

  // Clamp to the API contract (docs: grapheme clusters, ≤2048 bytes).
  let text = content.replace(/\s*\n+\s*/g, " ").trim();
  while (text.length > 0 && (Array.from(text).length > 480 || Buffer.byteLength(text, "utf8") > 2000)) {
    text = Array.from(text).slice(0, Array.from(text).length - 20).join("").trim();
  }
  if (!text) return { ok: false, code: "EMPTY" };

  const exec = async () => {
    // Gap enforcement (serialized through the same chain).
    const wait = rt.lastChatSentAt + CHAT_SEND_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    rt.lastChatSentAt = Date.now();
    try {
      const res = await kickApiFetch("/public/v1/chat", {
        method: "POST",
        body: JSON.stringify({ content: text, type: "bot" }),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: { is_sent?: boolean; message_id?: string }; message?: string };
      if (!res.ok) return { ok: false, code: `HTTP_${res.status}` };
      if (body.data?.is_sent === false) return { ok: false, code: "NOT_SENT" };
      return { ok: true, messageId: body.data?.message_id };
    } catch (e) {
      return { ok: false, code: e instanceof Error ? e.message : "NETWORK" };
    }
  };

  const chained = rt.sendChain.then(exec, exec);
  rt.sendChain = chained.catch(() => undefined);
  return chained;
}

// ---------------------------------------------------------------------------
// Webhook subscriptions
// ---------------------------------------------------------------------------

export async function kickListWebhookSubs(): Promise<KickWebhookSub[] | null> {
  try {
    const res = await kickApiFetch("/public/v1/events/subscriptions", { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: Array<{ id?: string; event?: string; version?: number; broadcaster_user_id?: number }>;
    };
    return (body.data ?? [])
      .filter((s) => typeof s.id === "string" && typeof s.event === "string")
      .map((s) => ({ id: s.id!, event: s.event!, version: Number(s.version) || 1 }));
  } catch {
    return null;
  }
}

/** Subscribes chat.message.sent (v1) to the given webhook URL. */
export async function kickSubscribeWebhook(url: string): Promise<{ ok: boolean; code?: string; subs?: KickWebhookSub[] }> {
  try {
    const res = await kickApiFetch("/public/v1/events/subscriptions", {
      method: "POST",
      body: JSON.stringify({ events: KICK_WEBHOOK_EVENTS.map((e) => ({ ...e })), method: "webhook" }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: Array<{ name?: string; version?: number; subscription_id?: string; error?: string }>;
      message?: string;
    };
    if (!res.ok) return { ok: false, code: `HTTP_${res.status}` };
    const subs: KickWebhookSub[] = (body.data ?? [])
      .filter((d) => typeof d.subscription_id === "string" && typeof d.name === "string")
      .map((d) => ({ id: d.subscription_id!, event: d.name!, version: Number(d.version) || 1 }));
    const hadError = (body.data ?? []).some((d) => d.error);
    return { ok: subs.length > 0 && !hadError, code: hadError ? "PARTIAL" : undefined, subs };
  } catch (e) {
    return { ok: false, code: e instanceof Error ? e.message : "NETWORK" };
  }
}

export async function kickUnsubscribe(ids: string[]): Promise<{ ok: boolean; code?: string }> {
  if (ids.length === 0) return { ok: true };
  try {
    const u = new URL(`${KICK_API_HOST}/public/v1/events/subscriptions`);
    for (const id of ids) u.searchParams.append("id", id);
    const res = await kickApiFetch(u.pathname + u.search, { method: "DELETE" });
    return res.ok || res.status === 204 ? { ok: true } : { ok: false, code: `HTTP_${res.status}` };
  } catch (e) {
    return { ok: false, code: e instanceof Error ? e.message : "NETWORK" };
  }
}

// ---------------------------------------------------------------------------
// Webhook verification (RSA public key — docs: fetch, never hardcode)
// ---------------------------------------------------------------------------

async function fetchKickPublicKey(force = false): Promise<string | null> {
  if (!force && rt.publicKey?.pem && Date.now() - rt.publicKey.fetchedAt < PUBLIC_KEY_TTL_MS) {
    return rt.publicKey.pem;
  }
  try {
    const res = await fetch(`${KICK_API_HOST}/public/v1/public-key`, {
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return rt.publicKey?.pem ?? null;
    const pem = (await res.text()).trim();
    if (!pem.includes("BEGIN PUBLIC KEY")) return rt.publicKey?.pem ?? null;
    rt.publicKey = { pem, fetchedAt: Date.now() };
    return pem;
  } catch {
    return rt.publicKey?.pem ?? null;
  }
}

export type KickWebhookVerify =
  | { valid: true; messageId: string }
  | { valid: false; reason: "BAD_SIGNATURE" | "MISSING_HEADERS" | "NO_KEY" | "STALE" | "DUPLICATE" };

/**
 * Full webhook gate: header presence → replay window (15 min) → RSA
 * PKCS1v15-SHA256 over `${messageId}.${timestamp}.${rawBody}` → idempotency.
 * Signatures are checked against the LIVE public key; on failure we refetch
 * once (key rotation) before rejecting. `keyOverride` lets the verification
 * pipeline be probed end-to-end with a local keypair (the panel can never
 * sign with Kick's private key — this is the only way to prove the gate).
 */
export async function verifyKickWebhook(opts: {
  rawBody: string;
  messageId: string | null;
  timestamp: string | null;
  signatureB64: string | null;
  keyOverride?: string;
}): Promise<KickWebhookVerify> {
  const { rawBody, messageId, timestamp, signatureB64 } = opts;
  if (!messageId || !timestamp || !signatureB64) return { valid: false, reason: "MISSING_HEADERS" };

  // Idempotency FIRST: Kick retries deliveries; a seen message-id is done.
  if (rt.seenEventIds.has(messageId)) return { valid: false, reason: "DUPLICATE" };
  // Replay window.
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 15 * 60_000) return { valid: false, reason: "STALE" };

  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  const data = Buffer.from(`${messageId}.${timestamp}.${rawBody}`);

  let pem = opts.keyOverride ?? (await fetchKickPublicKey());
  if (!pem) return { valid: false, reason: "NO_KEY" };
  const check = (key: string) => {
    try {
      return crypto.verify("sha256", data, key, sig);
    } catch {
      return false;
    }
  };
  if (!check(pem)) {
    // Public key may have rotated — refetch once and re-check before
    // rejecting. With a keyOverride there is nothing to rotate: the
    // override IS the truth for probes.
    if (opts.keyOverride) return { valid: false, reason: "BAD_SIGNATURE" };
    const rotated = await fetchKickPublicKey(true);
    if (!rotated || !check(rotated)) return { valid: false, reason: "BAD_SIGNATURE" };
  }

  // Mark seen (LRU cap 500).
  rt.seenEventIds.set(messageId, Date.now());
  if (rt.seenEventIds.size > 500) {
    const oldest = rt.seenEventIds.keys().next().value;
    if (oldest !== undefined) rt.seenEventIds.delete(oldest);
  }
  return { valid: true, messageId };
}
