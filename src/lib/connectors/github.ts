import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * NEXUS OS — GitHub connector (T-202).
 *
 * Auth model (directive A8 — binding):
 *   1. OAuth 2.0 web-flow click is ALWAYS the first option:
 *        /api/github/authorize -> 302 github.com/login/oauth/authorize -> /api/github/callback
 *   2. Device flow (github.com/login/device/code) exists ONLY as the documented
 *      fallback for headless setups — never the default path.
 *   3. PATs are PERMANENTLY REFUSED. Any PAT-looking string submitted to a GitHub
 *      route is rejected with code PAT_REFUSED and never processed or stored.
 *
 * Credential layout in the encrypted vault: service "github", label "oauth",
 * value = the OAuth USER access token. App credentials (GITHUB_CLIENT_ID /
 * GITHUB_CLIENT_SECRET / GITHUB_REDIRECT_URI) are non-user app config and live
 * in .env (optional — absent means an honest "not configured" state).
 *
 * P7: this module never logs, echoes, or embeds tokens/codes/secrets. Errors
 * carry short codes only.
 */

export const GITHUB_SERVICE = "github" as const;
export const GITHUB_LABEL = "oauth" as const;

export const GITHUB_SCOPES = ["repo", "read:user"] as const;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes, single-use
export const DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;

export const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEVICE_CODE_URL = "https://github.com/login/device/code";
const API_USER_URL = "https://api.github.com/user";
const USER_AGENT = "NEXUS-OS-panel (T-202)";

export type GitHubAppConfig = { clientId: string | null; configured: boolean };

/** App creds come from env; absent env = honest not-configured, never a stub. */
export function githubAppConfig(): GitHubAppConfig {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() || null;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() || null;
  return { clientId, configured: Boolean(clientId && clientSecret) };
}

/** Origin of the incoming request (gateway-aware via x-forwarded-*). */
export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host.split(",")[0].trim()}`;
  }
  return new URL(req.url).origin;
}

/** redirect_uri: explicit override wins, otherwise request-origin based. */
export function buildRedirectUri(req: Request): string {
  const override = process.env.GITHUB_REDIRECT_URI?.trim();
  if (override) return override;
  return `${requestOrigin(req)}/api/github/callback`;
}

// ---------------------------------------------------------------------------
// OAuth state store — in-memory Map (single-process dev scale), 10-min TTL,
// single-use consume. Survives nothing (documented limitation).
// ---------------------------------------------------------------------------

type OAuthStateEntry = { redirectUri: string; createdAt: number };
const oauthStates = new Map<string, OAuthStateEntry>();

function pruneOAuthStates(now = Date.now()): void {
  for (const [k, v] of oauthStates) {
    if (now - v.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(k);
  }
}

export function createOAuthState(redirectUri: string): string {
  pruneOAuthStates();
  const state = randomBytes(24).toString("base64url");
  oauthStates.set(state, { redirectUri, createdAt: Date.now() });
  return state;
}

/** Single-use: a valid state is deleted on first read. */
export function consumeOAuthState(state: string): OAuthStateEntry | null {
  pruneOAuthStates();
  const entry = oauthStates.get(state);
  if (!entry) return null;
  oauthStates.delete(state);
  if (Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return null;
  return entry;
}

export function oauthStateCount(): number {
  pruneOAuthStates();
  return oauthStates.size;
}

// ---------------------------------------------------------------------------
// A8 — PAT refusal helper. Detects GitHub PAT shapes; routes reject with 403.
// The value itself is never stored, transmitted, or echoed.
// ---------------------------------------------------------------------------

const GITHUB_PAT_PATTERNS = [
  /^ghp_[A-Za-z0-9]{16,}$/, // classic personal access token
  /^gho_[A-Za-z0-9]{16,}$/, // OAuth token (also refused for manual entry)
  /^gh[su]_[A-Za-z0-9]{16,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/, // fine-grained PAT
];

export function looksLikeGitHubPat(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 10) return false;
  return GITHUB_PAT_PATTERNS.some((re) => re.test(v));
}

// ---------------------------------------------------------------------------
// Vault access (service "github", label "oauth") — token never returned to UI.
// ---------------------------------------------------------------------------

export async function getGitHubToken(): Promise<string | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: GITHUB_SERVICE, label: GITHUB_LABEL } },
  });
  if (!row) return null;
  try {
    return decryptSecret(row.cipher);
  } catch {
    return null; // integrity failure — treat as absent; route reports honestly
  }
}

export async function storeGitHubToken(token: string): Promise<void> {
  const { keyId, cipher } = encryptSecret(token);
  await db.credential.upsert({
    where: { service_label: { service: GITHUB_SERVICE, label: GITHUB_LABEL } },
    create: { service: GITHUB_SERVICE, label: GITHUB_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function deleteGitHubToken(): Promise<boolean> {
  const res = await db.credential.deleteMany({
    where: { service: GITHUB_SERVICE, label: GITHUB_LABEL },
  });
  return res.count > 0;
}

// ---------------------------------------------------------------------------
// GitHub HTTP calls (app-facing). Response bodies are reduced to codes —
// full bodies are never forwarded, so tokens/codes cannot leak via errors.
// ---------------------------------------------------------------------------

export type TokenExchangeResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

/** Exchange an OAuth code for a user access token. P7: never logs inputs. */
export async function exchangeCodeForToken(params: {
  code: string;
  redirectUri: string;
}): Promise<TokenExchangeResult> {
  const app = githubAppConfig();
  if (!app.configured || !app.clientId) return { ok: false, error: "not_configured" };

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: process.env.GITHUB_CLIENT_SECRET ?? "",
        code: params.code,
        redirect_uri: params.redirectUri,
      }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const data = (await res.json().catch(() => null)) as
    | { access_token?: unknown; error?: unknown }
    | null;
  if (!res.ok || typeof data?.access_token !== "string" || data.access_token.length === 0) {
    return { ok: false, error: typeof data?.error === "string" ? data.error : `http_${res.status}` };
  }
  return { ok: true, accessToken: data.access_token };
}

export type GitHubUserProbe =
  | { ok: true; httpStatus: number; login: string }
  | { ok: false; httpStatus: number };

/** GET /user with the stored token — proves the token is live (MEASURED). */
export async function fetchGitHubUser(token: string): Promise<GitHubUserProbe> {
  let res: Response;
  try {
    res = await fetch(API_USER_URL, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      cache: "no-store",
    });
  } catch {
    return { ok: false, httpStatus: 0 };
  }
  if (!res.ok) return { ok: false, httpStatus: res.status };
  const data = (await res.json().catch(() => null)) as { login?: unknown } | null;
  if (!data || typeof data.login !== "string") return { ok: false, httpStatus: res.status };
  return { ok: true, httpStatus: res.status, login: data.login };
}

// ---------------------------------------------------------------------------
// Device flow (documented FALLBACK only). device_code stays server-side in the
// in-memory flow map — the browser only ever sees user_code + verification_uri.
// ---------------------------------------------------------------------------

export type DeviceFlowStart =
  | { ok: true; deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
  | { ok: false; error: string };

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const app = githubAppConfig();
  if (!app.configured || !app.clientId) return { ok: false, error: "not_configured" };

  let res: Response;
  try {
    res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ client_id: app.clientId, scope: GITHUB_SCOPES.join(" ") }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "network" };
  }

  const data = (await res.json().catch(() => null)) as
    | {
        device_code?: unknown;
        user_code?: unknown;
        verification_uri?: unknown;
        interval?: unknown;
        expires_in?: unknown;
      }
    | null;
  if (
    !res.ok ||
    typeof data?.device_code !== "string" ||
    typeof data?.user_code !== "string" ||
    typeof data?.verification_uri !== "string"
  ) {
    return { ok: false, error: `http_${res.status}` };
  }
  return {
    ok: true,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: typeof data.interval === "number" && data.interval > 0 ? data.interval : 5,
    expiresIn: typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 900,
  };
}

export type DevicePollResult =
  | { status: "connected" }
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; error: string };

/** One polling round against the token endpoint. Stores the vault on success. */
export async function pollDeviceFlow(deviceCode: string): Promise<DevicePollResult> {
  const app = githubAppConfig();
  if (!app.configured || !app.clientId) return { status: "error", error: "not_configured" };

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: app.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      cache: "no-store",
    });
  } catch {
    return { status: "error", error: "network" };
  }

  const data = (await res.json().catch(() => null)) as
    | { access_token?: unknown; error?: unknown; interval?: unknown }
    | null;

  if (typeof data?.access_token === "string" && data.access_token.length > 0) {
    await storeGitHubToken(data.access_token);
    await logGitHubEvent("github.connected", { via: "device-flow" });
    return { status: "connected" };
  }

  const err = typeof data?.error === "string" ? data.error : `http_${res.status}`;
  switch (err) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", interval: typeof data?.interval === "number" ? data.interval : 10 };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return { status: "error", error: err };
  }
}

// ---------------------------------------------------------------------------
// Device flow session map — flow id -> server-side device_code session.
// ---------------------------------------------------------------------------

type DeviceFlowSession = { deviceCode: string; interval: number; expiresAt: number };
const deviceFlows = new Map<string, DeviceFlowSession>();

function pruneDeviceFlows(now = Date.now()): void {
  for (const [k, v] of deviceFlows) {
    if (now > v.expiresAt) deviceFlows.delete(k);
  }
}

export function putDeviceFlowSession(start: Extract<DeviceFlowStart, { ok: true }>): {
  flowId: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
} {
  pruneDeviceFlows();
  const flowId = randomBytes(16).toString("base64url");
  deviceFlows.set(flowId, {
    deviceCode: start.deviceCode,
    interval: start.interval,
    expiresAt: Date.now() + Math.min(start.expiresIn, DEVICE_FLOW_TTL_MS / 1000) * 1000,
  });
  return {
    flowId,
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    interval: start.interval,
    expiresIn: start.expiresIn,
  };
}

export function getDeviceFlowSession(flowId: string): DeviceFlowSession | null {
  pruneDeviceFlows();
  return deviceFlows.get(flowId) ?? null;
}

export function deleteDeviceFlowSession(flowId: string): void {
  deviceFlows.delete(flowId);
}

// ---------------------------------------------------------------------------
// Terminal-flow tombstones (Round-9 fix, re-applied in R11 restore).
// Once a flow reaches a terminal state we remember it briefly so a replayed
// GET ?flow=… returns the SAME terminal status instead of a 404 FLOW_NOT_FOUND
// (which the panel surfaced as a false "device flow interrupted" toast when
// panel invalidation raced the final poll). Bounded, TTL'd, swept lazily.
// ---------------------------------------------------------------------------

const TOMBSTONE_TTL_MS = 5 * 60 * 1000;
const TOMBSTONE_MAX = 50;
const completedFlows = new Map<string, { status: string; ts: number }>();

function sweepCompletedFlows(now = Date.now()): void {
  if (completedFlows.size === 0) return;
  for (const [k, v] of completedFlows) {
    if (now - v.ts > TOMBSTONE_TTL_MS) completedFlows.delete(k);
  }
}

export function rememberTerminalFlow(flowId: string, status: string): void {
  sweepCompletedFlows();
  completedFlows.set(flowId, { status, ts: Date.now() });
  while (completedFlows.size > TOMBSTONE_MAX) {
    const oldest = completedFlows.keys().next().value;
    if (oldest === undefined) break;
    completedFlows.delete(oldest);
  }
}

export function getTerminalFlow(flowId: string): string | null {
  sweepCompletedFlows();
  return completedFlows.get(flowId)?.status ?? null;
}

// ---------------------------------------------------------------------------
// L0 event tap — connector lifecycle lands in the stream (best-effort; the
// panel Stream tab then shows real connector state, not a mock).
// ---------------------------------------------------------------------------

export async function logGitHubEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.event.create({
      data: {
        source: "connector",
        type,
        level: "info",
        actor: "panel",
        payload: JSON.stringify(payload),
      },
    });
  } catch {
    // L0 write is best-effort; never mask the primary result
  }
}
