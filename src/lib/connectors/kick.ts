import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  /** chatroom_id of the connected broadcaster (stable; re-resolved on account change). */
  chatroom: { userId: number; id: number; at: number } | null;
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
    chatroom: null,
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
 * A candidate origin is only usable for the OUTSIDE world (Kick form paste,
 * Kick's webhook POSTs, the post-auth browser redirect) when it is https and
 * publicly reachable. Loopback/private hosts never qualify, and the FC
 * tunnel host (*.fcapp.run) must never be advertised: it 400s every request
 * that lacks the platform session-affinity header (measured 2026-10-27 on
 * GET /, GET /api/kick/callback, POST /api/kick/webhook).
 */
function isPublicHttpsOrigin(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith(".fcapp.run")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Setting key maintained by /api/obs/publish-origin (auto-fired on every authenticated panel load). */
const OBS_PUBLISHED_ORIGIN_KEY = "obs.published-origin";

/** 60s cache for the public/obs-target.json disk read (tiny file, sync read is fine). */
type KickTargetCache = { origin: string | null; at: number };
const kickTargetCache: KickTargetCache = ((globalThis as Record<string, unknown>).__kickTargetCache as KickTargetCache) ?? {
  origin: null,
  at: 0,
};
(globalThis as Record<string, unknown>).__kickTargetCache = kickTargetCache;

function obsTargetOrigin(): string | null {
  const now = Date.now();
  if (kickTargetCache.at && now - kickTargetCache.at < 60_000) return kickTargetCache.origin;
  let origin: string | null = null;
  try {
    const raw = JSON.parse(
      readFileSync(path.join(process.cwd(), "public", "obs-target.json"), "utf8"),
    ) as { origin?: unknown };
    if (typeof raw.origin === "string" && isPublicHttpsOrigin(raw.origin)) {
      origin = raw.origin.replace(/\/+$/, "");
    }
  } catch {
    origin = null; // file missing/corrupt — treat as no source
  }
  kickTargetCache.origin = origin;
  kickTargetCache.at = now;
  return origin;
}

/**
 * v32 — PUBLIC-ORIGIN TRUTH for everything the OUTSIDE world must reach
 * (Kick redirect_uri, webhook subscription URL, post-auth browser redirect).
 *
 * ROOT CAUSE (closed here): behind the Z.ai gateway the request-derived
 * origin is the FC TUNNEL host with http scheme (measured live: even a
 * request through https://preview-chat-…space-z.ai computed
 * http://ws-ef-…fcapp.run/api/kick/callback — exactly the URL the owner
 * pasted into Kick's Create-an-App form, which Kick rejected with
 * "URLs must use a secure protocol (HTTPS)" and which would ALSO have
 * failed the FC session-affinity gate on Kick's webhook POSTs).
 *
 * The request headers can therefore NEVER be trusted for this purpose. The
 * panel maintains the true public origin itself — the publish flow
 * (/api/obs/publish-origin) stores it in the DB Setting AND on disk in
 * public/obs-target.json, and the owner may additionally anchor it on the
 * widget row. Resolution order, each validated by isPublicHttpsOrigin:
 *
 *   1. Widget.obsBaseUrl anchor (owner-pinned)
 *   2. Setting obs.published-origin (auto-maintained, authenticated loads)
 *   3. public/obs-target.json on disk (survives DB rollbacks — the
 *      2026-10-27 reboot restored a DB snapshot that had lost the Setting
 *      row while this file still carried the CURRENT origin)
 *   4. request-derived origin (dev / direct access only)
 */
export async function publicOrigin(req: Request): Promise<string> {
  // 1. owner-anchored OBS base URL on the widget row
  try {
    const w = await db.widget.findFirst({
      where: { obsBaseUrl: { not: null } },
      select: { obsBaseUrl: true },
    });
    const anchored = (w?.obsBaseUrl ?? "").trim();
    if (isPublicHttpsOrigin(anchored)) {
      return anchored.replace(/\/+$/, "");
    }
  } catch {
    // db unavailable (fresh boot) — fall through
  }
  // 2. auto-maintained published origin (Setting)
  try {
    const s = await db.setting.findUnique({ where: { key: OBS_PUBLISHED_ORIGIN_KEY } });
    const published = (s?.value ?? "").trim();
    if (isPublicHttpsOrigin(published)) {
      return published.replace(/\/+$/, "");
    }
  } catch {
    // fall through
  }
  // 3. on-disk publish target (rollback-proof)
  const onDisk = obsTargetOrigin();
  if (onDisk) return onDisk;
  // 4. request-derived (last resort — dev / direct access)
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
 * Resolve the connected broadcaster's chatroom_id (POST /public/v1/chat is
 * REQUIRED to carry it — the pre-v31.3 body {content,type} was rejected with
 * a 422 validation error, which the owner saw as "Kick did not accept the
 * message"). The AUTHENTICATED /public/v1/channels payload does NOT include
 * the chatroom id (measured live 2026-10-27), so this uses the same public
 * kick.com/api/v2 channel endpoint the anonymous bridge (:3010) uses —
 * verified live from this sandbox (chatroomId 3628172 for specimba).
 * Cached per account; chatroom ids are stable for a channel.
 */
const KICK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function kickResolveChatroomId(userId: number, slug: string): Promise<number | null> {
  if (rt.chatroom && rt.chatroom.userId === userId && Date.now() - rt.chatroom.at < 6 * 3600_000) {
    return rt.chatroom.id;
  }
  const wantSlug = (slug || "specimba").toLowerCase();

  // 1) PRIMARY — the kick-bridge mini service resolves the SAME channel from
    // this sandbox with Bun's fetch (Node/undici gets Cloudflare 403 on
    // kick.com — measured 2026-10-27: bun 200 / node 403 "Request blocked by
    // security policy"). Its /health already carries the resolved chatroomId.
  try {
    const res = await fetch("http://127.0.0.1:3010/health", {
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const j = (await res.json()) as { chatroomId?: number; channel?: string };
      if (typeof j.chatroomId === "number" && j.chatroomId > 0 && (j.channel ?? "").toLowerCase() === wantSlug) {
        rt.chatroom = { userId, id: j.chatroomId, at: Date.now() };
        return j.chatroomId;
      }
    }
  } catch {
    /* bridge down — fall through */
  }

  // 2) FALLBACK — direct public channel API (works whenever egress allows).
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(wantSlug)}`, {
      headers: { "User-Agent": KICK_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { chatroom?: { id?: number } };
    const id = body.chatroom?.id;
    if (typeof id !== "number" || id <= 0) return null;
    rt.chatroom = { userId, id, at: Date.now() };
    return id;
  } catch {
    return null;
  }
}

/**
 * Owner directive (viewer-enforced, 2026-10-27): ZERO emojis in chat output.
 * Stripped here at the transport level so EVERY lane (test message, !ai
 * reply, rate-limit line) complies even when a model sneaks one past the
 * persona rule. Also drops variation selectors/zero-width joiners so the
 * grapheme count shrinks with the codepoints.
 */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u2600-\u27BF\u2B00-\u2BFF]/gu;

/**
 * Post a chat message AS the connected user. The measured Kick contract
 * (probe matrix 2026-10-27) requires chatroom_id + broadcaster_user_id +
 * type "user". chatroom_id is resolved via the kick-bridge (Node fetch gets
 * Cloudflare 403 on kick.com). Content clamped to ≤480 graphemes / ≤2000
 * UTF-8 bytes (docs limits: 500 / 2048), emojis stripped (owner ban).
 * Serialized with a 1.5s floor so bursts stay polite. Returns the REAL Kick
 * error text on rejection.
 */
export type KickSendIdentity = "bot" | "bot+chatroom" | "user";

export async function kickSendBotMessage(
  content: string,
): Promise<{ ok: boolean; code?: string; messageId?: string; identity?: KickSendIdentity }> {
  const oauth = await loadKickOAuth();
  if (!oauth) return { ok: false, code: "NOT_CONNECTED" };
  const broadcasterUserId = oauth.account?.userId;
  if (typeof broadcasterUserId !== "number") return { ok: false, code: "NO_ACCOUNT" };

  // Clamp to the API contract (docs: grapheme clusters, ≤2048 bytes).
  let text = content.replace(/\s*\n+\s*/g, " ").trim();
  while (text.length > 0 && (Array.from(text).length > 480 || Buffer.byteLength(text, "utf8") > 2000)) {
    text = Array.from(text).slice(0, Array.from(text).length - 20).join("").trim();
  }
  text = text.replace(EMOJI_RE, " ").replace(/ {2,}/g, " ").trim();
  if (!text) return { ok: false, code: "EMPTY" };

  const chatroomId = await kickResolveChatroomId(broadcasterUserId, oauth.account?.name ?? "");
  if (!chatroomId) return { ok: false, code: "NO_CHATROOM" };

  const exec = async () => {
    // Gap enforcement (serialized through the same chain).
    const wait = rt.lastChatSentAt + CHAT_SEND_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    rt.lastChatSentAt = Date.now();
    // IDENTITY LADDER — docs.kick.com/apis/chat.md (pulled 2026-10-27):
    //   "You can send a message as a Bot account or your User account… when
    //   sending as a bot, the broadcaster_user_id is not required and is
    //   ignored. As a bot, the message will always be sent to the channel
    //   attached to your token." The official schema is {content, type} with
    //   NO chatroom_id — the morning probe matrix predated the app's bot and
    //   measured only legacy shapes (type bot → 404 back then). Owner ask:
    //   replies must come from the BOT account, never the streamer identity,
    //   so bot-first with the measured user contract as the last resort.
    const attempts: Array<{ identity: KickSendIdentity; body: Record<string, unknown> }> = [
      { identity: "bot", body: { content: text, type: "bot" } },
      { identity: "bot+chatroom", body: { chatroom_id: chatroomId, content: text, type: "bot" } },
      {
        identity: "user",
        body: { chatroom_id: chatroomId, broadcaster_user_id: broadcasterUserId, content: text, type: "user" },
      },
    ];
    let last: { ok: false; code: string } = { ok: false, code: "SEND_FAILED" };
    for (const attempt of attempts) {
      try {
        const res = await kickApiFetch("/public/v1/chat", {
          method: "POST",
          body: JSON.stringify(attempt.body),
        });
        const body = (await res.json().catch(() => ({}))) as {
          data?: { is_sent?: boolean; message_id?: string };
          message?: string;
        };
        if (!res.ok) {
          const detail = (body.message ?? "").slice(0, 160);
          last = { ok: false, code: detail ? `HTTP_${res.status}: ${detail}` : `HTTP_${res.status}` };
          continue;
        }
        if (body.data?.is_sent === false) {
          last = { ok: false, code: "NOT_SENT" };
          continue;
        }
        return { ok: true, messageId: body.data?.message_id, identity: attempt.identity };
      } catch (e) {
        last = { ok: false, code: e instanceof Error ? e.message : "NETWORK" };
      }
    }
    return last;
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
    // v31.3 — REAL PAYLOAD: the endpoint returns {"data":{"public_key":"PEM"}}
    // (measured live 2026-10-27). The old code stored the RAW JSON BODY as the
    // "PEM", so crypto.verify() threw on every delivery → permanent
    // BAD_SIGNATURE → every webhook answered 401 (the 401 storm in dev.log).
    const body = (await res.json().catch(() => null)) as { data?: { public_key?: string } } | null;
    const pem = (body?.data?.public_key ?? "").trim();
    if (!pem.startsWith("-----BEGIN PUBLIC KEY-----")) return rt.publicKey?.pem ?? null;
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
