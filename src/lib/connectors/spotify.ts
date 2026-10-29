import crypto from "node:crypto";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { publicOrigin } from "@/lib/connectors/kick";

/**
 * NEXUS OS v37 — Spotify connector (Phase G1, docs/capability-upgrade-plan.md §3).
 *
 * The owner's livestream plays Spotify on stream; viewers ask the bot about
 * the CURRENTLY PLAYING song and the bot was blind ("sesi duyamam" — true, but
 * it never knew a now-playing data feed could give it song TITLES). This
 * connector is the grounding source: read-only, least-privilege OAuth (PKCE
 * public client — NO client secret), mirroring the measured kick.ts patterns
 * one-to-one (globalThis runtime, single-flight refresh, rotating-pair
 * persistence, state-map PKCE, 10-min TTL, honest state machine).
 *
 * GROUND TRUTH (Spotify Web API, stable contract):
 *   - authorize: GET https://accounts.spotify.com/authorize
 *       ?response_type=code&client_id&scope&redirect_uri&state
 *       &code_challenge&code_challenge_method=S256        (PKCE, no secret)
 *   - token:     POST https://accounts.spotify.com/api/token
 *       (application/x-www-form-urlencoded)
 *       grant_type=authorization_code|refresh_token &client_id &code_verifier
 *       refresh responses usually OMIT refresh_token — keep the previous one.
 *   - player:    GET https://api.spotify.com/v1/me/player        (Bearer)
 *       200 {is_playing, progress_ms, item:{…}|null, device:{…}}
 *       204 No Content = no active device / nothing playing
 *       item.type "track" | "episode"; is_local tracks have no external URL.
 *
 * Vault layout (service "spotify"):
 *   label "app"   → JSON {clientId}            (PKCE public client)
 *   label "oauth" → JSON {accessToken, refreshToken, expiresAt, scope,
 *                          account:{id,name}, savedAt, redirectUriUsed}
 *
 * HONEST STATE MACHINE (the card and the deterministic lane render the
 * same enum — never a stub):
 *   NOT_CONFIGURED → no app row    NEEDS_REAUTH → refresh rejected
 *   IDLE  → 204 / no track         PAUSED → is_playing:false with a track
 *   PLAYING → live track           DEGRADED → circuit breaker open
 *
 * PERF BUDGET (D7): `peekNowPlaying()` is a pure sync memory read used by the
 * prompt cards — zero hot-path latency. Fetches happen on the panel-Brain-tab
 * heartbeat (`/api/brain/nowplaying`, 15-20s poll) and the bounded
 * deterministic lane (≤1.5s — house-legal, STATUS lane already blocks ~4s).
 */

export const SPOTIFY_SERVICE = "spotify";
const APP_LABEL = "app";
const OAUTH_LABEL = "oauth";

export const SPOTIFY_ACCOUNTS_HOST = "https://accounts.spotify.com";
export const SPOTIFY_API_HOST = "https://api.spotify.com";

/** Least privilege: read-only playback state. Nothing else is requested. */
export const SPOTIFY_SCOPES = ["user-read-currently-playing", "user-read-playback-state"] as const;
export const SPOTIFY_SCOPE_HINTS: Record<string, string> = {
  "user-read-currently-playing": "Read the currently playing track",
  "user-read-playback-state": "Read playback state (device, paused/playing)",
};

const TOKEN_TTL_MARGIN_MS = 120_000; // refresh two minutes before expiry
const PKCE_TTL_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const BOUNDED_FETCH_MS = 1_500; // deterministic-lane hard bound (plan §3)
const SNAPSHOT_TTL_MS = 25_000; // below this age, no refresh is even attempted
const FRESH_MS = 5 * 60_000; // YAYIN card / "fresh" definition
const STALE_MS = 10 * 60_000; // hydrated-from-disk snapshot max useful age
const BREAKER_FAILS = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const OAUTH_CACHE_MS = 30_000; // decrypted oauth cache (avoid per-poll vault reads)
const HISTORY_MAX = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpotifyApp = { clientId: string };

export type SpotifyOAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope: string;
  account?: { id: string; name: string };
  savedAt: number;
  redirectUriUsed?: string;
};

export type SpotifyTrack = {
  id: string; // spotify id, or "local:<hash>" for is_local items
  name: string;
  artists: string; // "A" or "A, B"
  album: string;
  year: string; // "" when unknown
  durationMs: number;
  progressMs: number;
  url: string | null; // null for is_local
  isLocal: boolean;
  kind: "track" | "episode";
};

export type SpotifyState =
  | "NOT_CONFIGURED"
  | "NEEDS_REAUTH"
  | "IDLE"
  | "PAUSED"
  | "PLAYING"
  | "DEGRADED";

export type SpotifySnapshot = {
  state: SpotifyState;
  isPlaying: boolean;
  track: SpotifyTrack | null;
  device: string | null;
  fetchedAt: number; // epoch ms of the last SUCCESSFUL API read (or hydration)
  stale: boolean; // served from memory/disk cache beyond freshness window
};

export type SpotifyHistoryEntry = {
  ts: number;
  id: string;
  name: string;
  artists: string;
  album: string;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Runtime store (process-wide — the v29.20 Turbopack lesson from kick.ts)
// ---------------------------------------------------------------------------

type SpotifyRuntime = {
  pkce: Map<string, { verifier: string; redirectUri: string; createdAt: number }>;
  refreshInFlight: Promise<SpotifyOAuth> | null;
  /** single-flight now-playing refresh (peek warms, bounded awaits) */
  npInFlight: Promise<SpotifySnapshot> | null;
  snapshot: SpotifySnapshot | null;
  hydrated: boolean; // Setting→memory hydration done
  oauthCache: { oauth: SpotifyOAuth | null; at: number };
  failStreak: number;
  lastFailAt: number;
  lastTransportError: string;
  reauthFlag: boolean; // sticky NEEDS_REAUTH until reconnect
  history: SpotifyHistoryEntry[] | null;
};

const g = globalThis as typeof globalThis & { __nexusSpotifyRuntime?: SpotifyRuntime };
const rt: SpotifyRuntime =
  g.__nexusSpotifyRuntime ??
  (g.__nexusSpotifyRuntime = {
    pkce: new Map(),
    refreshInFlight: null,
    npInFlight: null,
    snapshot: null,
    hydrated: false,
    oauthCache: { oauth: null, at: 0 },
    failStreak: 0,
    lastFailAt: 0,
    lastTransportError: "",
    reauthFlag: false,
    history: null,
  });

// ---------------------------------------------------------------------------
// Events (honest telemetry — source "connector", never secret-bearing)
// ---------------------------------------------------------------------------

function noteConnectorEvent(type: string, level: "info" | "warn" | "error", payload: Record<string, unknown>): void {
  try {
    void db.event
      .create({
        data: {
          source: "connector",
          type,
          level,
          payload: JSON.stringify(payload).slice(0, 8_000),
        },
      })
      .catch(() => {});
  } catch {
    /* db unavailable — telemetry is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export async function loadSpotifyApp(): Promise<SpotifyApp | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: SPOTIFY_SERVICE, label: APP_LABEL } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(decryptSecret(row.cipher)) as Partial<SpotifyApp>;
    if (typeof parsed.clientId === "string" && parsed.clientId.trim()) {
      return { clientId: parsed.clientId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveSpotifyApp(app: SpotifyApp): Promise<void> {
  const { keyId, cipher } = encryptSecret(JSON.stringify({ clientId: app.clientId.trim() }));
  await db.credential.upsert({
    where: { service_label: { service: SPOTIFY_SERVICE, label: APP_LABEL } },
    create: { service: SPOTIFY_SERVICE, label: APP_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
}

export async function deleteSpotifyApp(): Promise<number> {
  const res = await db.credential.deleteMany({ where: { service: SPOTIFY_SERVICE, label: APP_LABEL } });
  return res.count;
}

async function loadSpotifyOAuthRaw(): Promise<SpotifyOAuth | null> {
  const row = await db.credential.findUnique({
    where: { service_label: { service: SPOTIFY_SERVICE, label: OAUTH_LABEL } },
  });
  if (!row) return null;
  try {
    const parsed = JSON.parse(decryptSecret(row.cipher)) as Partial<SpotifyOAuth>;
    if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string" && parsed.refreshToken) {
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: Number(parsed.expiresAt) || 0,
        scope: String(parsed.scope ?? ""),
        account:
          parsed.account && typeof parsed.account.id === "string" && typeof parsed.account.name === "string"
            ? parsed.account
            : undefined,
        savedAt: Number(parsed.savedAt) || Date.now(),
        redirectUriUsed: typeof parsed.redirectUriUsed === "string" ? parsed.redirectUriUsed : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Cached vault read (30s TTL) — the poll loop must not hit the DB per call. */
async function loadSpotifyOAuth(): Promise<SpotifyOAuth | null> {
  const now = Date.now();
  if (now - rt.oauthCache.at < OAUTH_CACHE_MS) return rt.oauthCache.oauth;
  const oauth = await loadSpotifyOAuthRaw();
  rt.oauthCache = { oauth, at: now };
  return oauth;
}

export async function saveSpotifyOAuth(oauth: SpotifyOAuth): Promise<void> {
  const { keyId, cipher } = encryptSecret(JSON.stringify(oauth));
  await db.credential.upsert({
    where: { service_label: { service: SPOTIFY_SERVICE, label: OAUTH_LABEL } },
    create: { service: SPOTIFY_SERVICE, label: OAUTH_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });
  rt.oauthCache = { oauth, at: Date.now() };
  rt.reauthFlag = false;
}

export async function deleteSpotifyOAuth(): Promise<void> {
  await db.credential.deleteMany({ where: { service: SPOTIFY_SERVICE, label: OAUTH_LABEL } });
  rt.oauthCache = { oauth: null, at: Date.now() };
  rt.reauthFlag = false;
  rt.snapshot = null;
  rt.hydrated = true; // nothing left to hydrate
}

export function maskSpotifyApp(app: SpotifyApp): { clientIdMasked: string } {
  return { clientIdMasked: maskSecret(app.clientId) };
}

// ---------------------------------------------------------------------------
// PKCE (S256, mirror of kick.ts — no client secret anywhere)
// ---------------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function spotifyCallbackUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/connectors/spotify/callback`;
}

export function mintSpotifyAuth(app: SpotifyApp, redirectUri: string): { authorizeUrl: string; state: string } {
  const verifier = b64url(crypto.randomBytes(48)); // 64 chars — RFC 7636 range
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

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

  const u = new URL(`${SPOTIFY_ACCOUNTS_HOST}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", app.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: u.toString(), state };
}

export function spendSpotifyAuth(state: string): { verifier: string; redirectUri: string } | null {
  const rec = rt.pkce.get(state);
  if (!rec) return null;
  rt.pkce.delete(state);
  if (Date.now() - rec.createdAt > PKCE_TTL_MS) return null;
  return { verifier: rec.verifier, redirectUri: rec.redirectUri };
}

// ---------------------------------------------------------------------------
// Token endpoint (form-urlencoded — PKCE public client: client_id only)
// ---------------------------------------------------------------------------

type SpotifyTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function spotifyTokenRequest(form: Record<string, string>): Promise<SpotifyTokenResponse> {
  const res = await fetch(`${SPOTIFY_ACCOUNTS_HOST}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: SpotifyTokenResponse | null = null;
  try {
    body = JSON.parse(text) as SpotifyTokenResponse;
  } catch {
    /* fall through to status error */
  }
  if (!res.ok) {
    const code = body?.error ?? `HTTP_${res.status}`;
    throw new Error(code);
  }
  if (!body?.access_token) throw new Error("token response missing access_token");
  return body;
}

function oauthFromTokenResponse(t: SpotifyTokenResponse, prev?: SpotifyOAuth, redirectUriUsed?: string): SpotifyOAuth {
  const expiresInMs = Math.max(60, Number(t.expires_in) || 3600) * 1_000;
  return {
    accessToken: t.access_token,
    // Spotify does NOT rotate refresh tokens on normal refresh — keep prev.
    refreshToken: t.refresh_token || prev?.refreshToken || "",
    expiresAt: Date.now() + Math.max(expiresInMs - TOKEN_TTL_MARGIN_MS, 60_000),
    scope: String(t.scope ?? prev?.scope ?? SPOTIFY_SCOPES.join(" ")),
    account: prev?.account,
    savedAt: Date.now(),
    redirectUriUsed: redirectUriUsed ?? prev?.redirectUriUsed,
  };
}

export async function exchangeSpotifyCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  app: SpotifyApp;
}): Promise<SpotifyOAuth> {
  const t = await spotifyTokenRequest({
    grant_type: "authorization_code",
    client_id: opts.app.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  });
  return oauthFromTokenResponse(t, undefined, opts.redirectUri);
}

/** Best-effort revoke on disconnect — failures must not block the wipe. */
export async function revokeSpotifyTokens(): Promise<void> {
  const oauth = await loadSpotifyOAuthRaw();
  if (!oauth?.refreshToken) return;
  try {
    await fetch(`${SPOTIFY_ACCOUNTS_HOST}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: (await loadSpotifyApp())?.clientId ?? "",
        refresh_token: oauth.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    /* best-effort only */
  }
}

/**
 * Refresh single-flight. Proactive (margin 120s) so the stream never sees a
 * 401 loop; `force` is the 401-retry path. invalid_grant → NEEDS_REAUTH event.
 */
export async function refreshSpotifyOAuth(force = false): Promise<SpotifyOAuth> {
  const current = await loadSpotifyOAuth();
  if (!current) throw new Error("not connected");
  if (!force && Date.now() < current.expiresAt) return current;
  if (rt.refreshInFlight) return rt.refreshInFlight;

  const app = await loadSpotifyApp();
  if (!app) throw new Error("app credentials missing");
  if (!current.refreshToken) throw new Error("no refresh token stored");

  const flight = (async () => {
    const t = await spotifyTokenRequest({
      grant_type: "refresh_token",
      client_id: app.clientId,
      refresh_token: current.refreshToken,
    });
    const next = oauthFromTokenResponse(t, current);
    await saveSpotifyOAuth(next);
    return next;
  })();

  rt.refreshInFlight = flight;
  try {
    return await flight;
  } catch (e) {
    const code = e instanceof Error ? e.message : "refresh_failed";
    if (/invalid_grant|invalid_client/i.test(code)) {
      rt.reauthFlag = true;
      noteConnectorEvent("spotify.reauth-required", "warn", { code });
    }
    throw e;
  } finally {
    rt.refreshInFlight = null;
  }
}

/** GET /v1/me — account display name for the card (never the full profile). */
export async function getSpotifyUser(): Promise<{ id: string; name: string } | null> {
  const oauth = await refreshSpotifyOAuth().catch(() => null);
  if (!oauth) return null;
  const res = await fetch(`${SPOTIFY_API_HOST}/v1/me`, {
    headers: { Authorization: `Bearer ${oauth.accessToken}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { id?: string; display_name?: string } | null;
  if (!body?.id) return null;
  return { id: String(body.id), name: String(body.display_name ?? body.id) };
}

// ---------------------------------------------------------------------------
// Setting persistence (seal-covered automatically — generic seal collector)
// ---------------------------------------------------------------------------

const SETTING_NOWPLAYING = "spotify.nowplaying";
const SETTING_HISTORY = "spotify.history";

type PersistedSnapshot = {
  state: SpotifyState;
  isPlaying: boolean;
  track: SpotifyTrack | null;
  device: string | null;
  fetchedAt: number;
};

async function persistSnapshot(snap: SpotifySnapshot): Promise<void> {
  const persist: PersistedSnapshot = {
    state: snap.state,
    isPlaying: snap.isPlaying,
    track: snap.track,
    device: snap.device,
    fetchedAt: snap.fetchedAt,
  };
  try {
    await db.setting.upsert({
      where: { key: SETTING_NOWPLAYING },
      create: { key: SETTING_NOWPLAYING, value: JSON.stringify(persist).slice(0, 8_000) },
      update: { value: JSON.stringify(persist).slice(0, 8_000) },
    });
  } catch {
    /* persistence is best-effort; memory snapshot remains authoritative */
  }
}

async function loadHistory(): Promise<SpotifyHistoryEntry[]> {
  if (rt.history) return rt.history;
  try {
    const row = await db.setting.findUnique({ where: { key: SETTING_HISTORY } });
    const parsed = row ? (JSON.parse(row.value) as SpotifyHistoryEntry[]) : [];
    rt.history = Array.isArray(parsed) ? parsed.slice(0, HISTORY_MAX) : [];
  } catch {
    rt.history = [];
  }
  return rt.history!;
}

async function persistHistory(entries: SpotifyHistoryEntry[]): Promise<void> {
  try {
    await db.setting.upsert({
      where: { key: SETTING_HISTORY },
      create: { key: SETTING_HISTORY, value: JSON.stringify(entries).slice(0, 16_000) },
      update: { value: JSON.stringify(entries).slice(0, 16_000) },
    });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Now-playing pool
// ---------------------------------------------------------------------------

function trackId(item: { id?: string | null; name?: string; is_local?: boolean; uri?: string }): string {
  if (item.id) return String(item.id);
  const seed = `${item.uri ?? item.name ?? "local"}:${item.is_local ? "local" : "remote"}`;
  return `local:${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function trackFromItem(item: Record<string, unknown> | null | undefined): SpotifyTrack | null {
  if (!item) return null;
  const type = item.type === "episode" ? "episode" : "track";
  const name = String(item.name ?? "").trim();
  if (!name) return null;
  if (type === "episode") {
    const show = (item.show ?? {}) as Record<string, unknown>;
    const ext = (item.external_urls ?? {}) as Record<string, unknown>;
    return {
      id: trackId(item as { id?: string | null; name?: string }),
      name,
      artists: String(show.publisher ?? show.name ?? ""),
      album: String(show.name ?? ""),
      year: "",
      durationMs: Number(item.duration_ms) || 0,
      progressMs: 0,
      url: typeof ext.spotify === "string" ? ext.spotify : null,
      isLocal: false,
      kind: "episode",
    };
  }
  const album = (item.album ?? {}) as Record<string, unknown>;
  const artists = Array.isArray(item.artists)
    ? (item.artists as Array<{ name?: string }>).map((a) => String(a?.name ?? "")).filter(Boolean).join(", ")
    : "";
  const ext = (item.external_urls ?? {}) as Record<string, unknown>;
  return {
    id: trackId(item as { id?: string | null; name?: string }),
    name,
    artists,
    album: String(album.name ?? ""),
    year: String(album.release_date ?? "").slice(0, 4),
    durationMs: Number(item.duration_ms) || 0,
    progressMs: 0,
    url: typeof ext.spotify === "string" && !item.is_local ? ext.spotify : null,
    isLocal: item.is_local === true,
    kind: "track",
  };
}

/** Boot/cold-start hydration — the last persisted snapshot, honestly aged. */
async function hydrateSnapshot(): Promise<SpotifySnapshot | null> {
  if (rt.snapshot || rt.hydrated) return rt.snapshot;
  try {
    const row = await db.setting.findUnique({ where: { key: SETTING_NOWPLAYING } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<PersistedSnapshot>;
      const age = Date.now() - Number(parsed.fetchedAt ?? 0);
      if (parsed && parsed.track !== undefined && age < STALE_MS) {
        rt.snapshot = {
          state: (parsed.state as SpotifyState) ?? "IDLE",
          isPlaying: parsed.isPlaying === true,
          track: (parsed.track as SpotifyTrack) ?? null,
          device: parsed.device ?? null,
          fetchedAt: Number(parsed.fetchedAt ?? 0),
          stale: age > FRESH_MS,
        };
      }
    }
  } catch {
    /* fresh boot / missing row — nothing to hydrate */
  }
  rt.hydrated = true;
  return rt.snapshot;
}

async function noteTransportFail(kind: string): Promise<void> {
  rt.failStreak += 1;
  rt.lastFailAt = Date.now();
  rt.lastTransportError = kind;
  if (rt.failStreak === BREAKER_FAILS) {
    noteConnectorEvent("spotify.transport-fail", "warn", { kind, streak: rt.failStreak });
  }
}

async function performNowPlayingFetch(): Promise<SpotifySnapshot> {
  // Circuit breaker: 3 consecutive transport failures → 60s cooldown.
  if (rt.failStreak >= BREAKER_FAILS && Date.now() - rt.lastFailAt < BREAKER_COOLDOWN_MS) {
    const cached = rt.snapshot;
    if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return { ...cached, stale: Date.now() - cached.fetchedAt > 30_000 };
    return {
      state: "DEGRADED",
      isPlaying: false,
      track: cached?.track ?? null,
      device: cached?.device ?? null,
      fetchedAt: cached?.fetchedAt ?? 0,
      stale: true,
    };
  }

  const oauthRow = await loadSpotifyOAuth();
  if (!oauthRow) {
    // No oauth row at all — the honest NOT_CONFIGURED path (first-class
    // production state, not a stub). The lane + card render the same enum.
    return { state: "NOT_CONFIGURED", isPlaying: false, track: null, device: null, fetchedAt: Date.now(), stale: false };
  }
  let oauth = await refreshSpotifyOAuth().catch(() => null);
  if (!oauth) {
    if (rt.reauthFlag) {
      return { state: "NEEDS_REAUTH", isPlaying: false, track: rt.snapshot?.track ?? null, device: null, fetchedAt: Date.now(), stale: true };
    }
    // transient refresh failure (network class) — breaker-aware degraded path
    await noteTransportFail("refresh");
    return degradedOrCached();
  }

  const call = (token: string) =>
    fetch(`${SPOTIFY_API_HOST}/v1/me/player`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

  let res = await call(oauth.accessToken).catch(() => null);
  if (res === null) {
    await noteTransportFail("network");
    return degradedOrCached();
  }
  // 401 → one single-flight force-refresh → one retry (kick.ts pattern).
  if (res.status === 401) {
    const refreshed = await refreshSpotifyOAuth(true).catch(() => null);
    if (!refreshed) {
      rt.reauthFlag = true;
      noteConnectorEvent("spotify.reauth-required", "warn", { code: "401_refresh_failed" });
      return { state: "NEEDS_REAUTH", isPlaying: false, track: rt.snapshot?.track ?? null, device: null, fetchedAt: Date.now(), stale: true };
    }
    oauth = refreshed;
    res = await call(refreshed.accessToken).catch(() => null);
    if (res === null) {
      await noteTransportFail("network-after-401");
      return degradedOrCached();
    }
  }
  if (res.status === 204) {
    rt.failStreak = 0;
    return commitSnapshot({ state: "IDLE", isPlaying: false, track: null, device: null });
  }
  if (!res.ok) {
    await noteTransportFail(`HTTP_${res.status}`);
    return degradedOrCached();
  }

  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    await noteTransportFail("bad_json");
    return degradedOrCached();
  }
  rt.failStreak = 0;
  rt.reauthFlag = false;
  const isPlaying = body.is_playing === true;
  const track = trackFromItem(body.item as Record<string, unknown> | null);
  const device = (body.device as { name?: string } | null)?.name ? String((body.device as { name?: string }).name) : null;
  if (track) track.progressMs = Number(body.progress_ms) || 0;
  const state: SpotifyState = isPlaying && track ? "PLAYING" : track ? "PAUSED" : "IDLE";
  return commitSnapshot({ state, isPlaying, track, device });
}

function degradedOrCached(): SpotifySnapshot {
  const cached = rt.snapshot;
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && age < FRESH_MS) return { ...cached, stale: true };
  return { state: "DEGRADED", isPlaying: false, track: cached?.track ?? null, device: cached?.device ?? null, fetchedAt: cached?.fetchedAt ?? 0, stale: true };
}

/** Single commit point: memory snapshot + change-driven persistence. */
async function commitSnapshot(snap: Omit<SpotifySnapshot, "fetchedAt" | "stale">): Promise<SpotifySnapshot> {
  const full: SpotifySnapshot = { ...snap, fetchedAt: Date.now(), stale: false };
  const prev = rt.snapshot;
  rt.snapshot = full;

  // Persist + history only on CHANGE (track or state), never per poll —
  // keeps the auto-reseal cadence negligible (plan §3, plan critique #5).
  const trackChanged = !prev || prev.track?.id !== full.track?.id;
  const stateChanged = !prev || prev.state !== full.state;
  if (trackChanged || stateChanged) {
    void persistSnapshot(full).catch(() => {});
    if (full.track) {
      const hist = await loadHistory();
      const last = hist[0];
      if (!last || last.id !== full.track.id) {
        const entry: SpotifyHistoryEntry = {
          ts: Date.now(),
          id: full.track.id,
          name: full.track.name,
          artists: full.track.artists,
          album: full.track.album,
          durationMs: full.track.durationMs,
        };
        const next = [entry, ...hist.filter((h) => h.id !== entry.id)].slice(0, HISTORY_MAX);
        rt.history = next;
        void persistHistory(next).catch(() => {});
      }
    }
  }
  return full;
}

/**
 * Sync memory read — THE hot-path primitive for the grounding cards.
 * Zero I/O. Warms an async refresh when the snapshot is older than the TTL,
 * but NEVER awaits it (D7: no added chat latency).
 */
export function peekNowPlaying(): SpotifySnapshot | null {
  const snap = rt.snapshot;
  if (!snap) {
    // Cold memory → hydrate + warm in the background; card omits until ready.
    void hydrateSnapshot()
      .then(() => refreshNowPlaying())
      .catch(() => {});
    return null;
  }
  if (Date.now() - snap.fetchedAt > SNAPSHOT_TTL_MS) {
    void refreshNowPlaying().catch(() => {});
  }
  return snap;
}

/** Single-flight refresh — concurrent callers share one HTTP round-trip. */
export function refreshNowPlaying(): Promise<SpotifySnapshot> {
  if (rt.npInFlight) return rt.npInFlight;
  const flight = (async () => {
    try {
      const snap = await performNowPlayingFetch();
      return snap;
    } finally {
      rt.npInFlight = null;
    }
  })();
  rt.npInFlight = flight;
  return flight;
}

/**
 * Bounded read for the deterministic NOWPLAYING lane: awaits the single
 * refresh for at most BOUNDED_FETCH_MS, then serves what exists. The STATUS
 * lane already blocks ~4s on live pings — 1.5s is inside house norms.
 */
export async function getNowPlayingBounded(): Promise<SpotifySnapshot> {
  const snap = peekNowPlaying();
  const age = snap ? Date.now() - snap.fetchedAt : Infinity;
  if (snap && age < SNAPSHOT_TTL_MS && !snap.stale) return snap;

  await hydrateSnapshot();
  const flight = refreshNowPlaying();
  try {
    const bounded = await Promise.race([
      flight,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BOUNDED_FETCH_MS)),
    ]);
    if (bounded) return bounded;
  } catch {
    /* timeout or failure — fall through to whatever we have */
  }
  const latest = rt.snapshot;
  if (latest) return { ...latest, stale: Date.now() - latest.fetchedAt > FRESH_MS };
  return { state: "IDLE", isPlaying: false, track: null, device: null, fetchedAt: 0, stale: true };
}

/** History ring for the "geçen parça neydi" lane + the panel Brain tab. */
export async function getSpotifyHistory(limit = 10): Promise<SpotifyHistoryEntry[]> {
  const hist = await loadHistory();
  return hist.slice(0, Math.max(1, Math.min(limit, HISTORY_MAX)));
}

export function snapshotIsFresh(snap: SpotifySnapshot | null): boolean {
  return !!snap && Date.now() - snap.fetchedAt < FRESH_MS;
}

/** The redirect URI the owner must register (public-origin truth from kick.ts). */
export async function spotifyRedirectUri(req: Request): Promise<string> {
  return spotifyCallbackUrl(await publicOrigin(req));
}

/** Public status shape for the card + /api/connectors/spotify/status. */
export async function spotifyStatus(req: Request): Promise<{
  configured: boolean;
  app: { clientIdMasked: string } | null;
  connected: boolean;
  account: { id: string; name: string } | null;
  scope: string | null;
  expiresAt: number | null;
  redirectUri: string;
  needsReauth: boolean;
  snapshot: PersistedSnapshot | null;
  historyCount: number;
  scopes: string[];
  scopeHints: Record<string, string>;
}> {
  const [app, oauth] = await Promise.all([loadSpotifyApp(), loadSpotifyOAuthRaw()]);
  const snap = rt.snapshot ?? (await hydrateSnapshot());
  const history = await loadHistory();
  return {
    configured: !!app,
    app: app ? maskSpotifyApp(app) : null,
    connected: !!oauth,
    account: oauth?.account ?? null,
    scope: oauth?.scope ?? null,
    expiresAt: oauth?.expiresAt ?? null,
    redirectUri: await spotifyRedirectUri(req),
    needsReauth: rt.reauthFlag,
    snapshot: snap
      ? { state: snap.state, isPlaying: snap.isPlaying, track: snap.track, device: snap.device, fetchedAt: snap.fetchedAt }
      : null,
    historyCount: history.length,
    scopes: [...SPOTIFY_SCOPES],
    scopeHints: { ...SPOTIFY_SCOPE_HINTS },
  };
}
