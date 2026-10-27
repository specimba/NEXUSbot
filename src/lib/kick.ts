/**
 * NEXUS OS — KICK channel telemetry fetcher (R21-b).
 *
 * Single shared fetcher behind the Stream tab's live-telemetry strip and the
 * beta-readiness checklist. Talks to kick.com's public /api/v2/channels/{slug}
 * endpoint with a browser-like User-Agent (kick sits behind Cloudflare; a bare
 * datacenter fetch is often answered with 403 — reported honestly as
 * UPSTREAM_403, never faked).
 *
 * 30s in-memory cache keyed by lowercase slug: the Stream tab polls every 30s
 * and the checklist also probes the channel, so the cache caps upstream hits at
 * one per 30s per channel. Server-side module cache — fine for single-process
 * dev; no cross-process coherence is claimed.
 *
 * Honesty contract: never fabricate data. Viewers/title degrade to null when
 * the upstream shape doesn't match; failures surface typed error codes.
 */

export type KickTelemetry = {
  isLive: boolean;
  viewers: number | null;
  title: string | null;
  thumbnail: string | null;
  fetchedAt: string;
};

export type KickTelemetryCode =
  | "INVALID_CHANNEL"
  | "UPSTREAM_403"
  | "UPSTREAM_5XX"
  | "TIMEOUT"
  | "PARSE"
  | "NETWORK";

export type KickTelemetryResult =
  | { ok: true; telemetry: KickTelemetry; cache: { hit: boolean; ageSec: number } | null }
  | { ok: false; code: KickTelemetryCode; message: string };

const KICK_CHANNEL_RE = /^[a-z0-9_]{2,30}$/i;
const CACHE_TTL_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 4_500;
const CACHE_MAX_KEYS = 200;

const cache = new Map<string, { at: number; payload: KickTelemetry }>();

/** Defensive viewer-count coercion — kick may send a number or numeric string. */
function coerceViewers(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function pruneCache(): void {
  if (cache.size <= CACHE_MAX_KEYS) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
}

export async function fetchKickTelemetry(channel: string): Promise<KickTelemetryResult> {
  const slug = channel.trim();
  if (!KICK_CHANNEL_RE.test(slug)) {
    return {
      ok: false,
      code: "INVALID_CHANNEL",
      message: `invalid channel slug "${channel}" — expected 2–30 chars of a-z / 0-9 / _`,
    };
  }
  const key = slug.toLowerCase();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return {
      ok: true,
      telemetry: hit.payload,
      cache: { hit: true, ageSec: Math.floor((Date.now() - hit.at) / 1000) },
    };
  }

  let res: Response;
  try {
    res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(key)}`, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        code: "TIMEOUT",
        message: `kick.com did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s`,
      };
    }
    return {
      ok: false,
      code: "NETWORK",
      message: e instanceof Error ? e.message : "network error reaching kick.com",
    };
  }

  if (res.status === 403) {
    return {
      ok: false,
      code: "UPSTREAM_403",
      message: "kick.com blocked the request (Cloudflare) — telemetry unavailable from the sandbox",
    };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      code: "UPSTREAM_5XX",
      message: `kick.com answered HTTP ${res.status} (upstream outage)`,
    };
  }
  if (!res.ok) {
    return { ok: false, code: "NETWORK", message: `kick.com answered HTTP ${res.status}` };
  }

  // JSON shape varies between channel states (live / offline / deleted) — parse
  // defensively; anything unexpected degrades to null fields, never a guess.
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, code: "PARSE", message: "kick.com sent a non-JSON body" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, code: "PARSE", message: "kick.com JSON was not a channel object" };
  }

  const root = json as Record<string, unknown>;
  const ls =
    typeof root.livestream === "object" && root.livestream !== null
      ? (root.livestream as Record<string, unknown>)
      : null;

  const rawTitle =
    typeof ls?.session_title === "string" && ls.session_title.length > 0
      ? ls.session_title
      : typeof ls?.title === "string" && ls.title.length > 0
        ? ls.title
        : null;
  const thumbObj =
    ls && typeof ls.thumbnail === "object" && ls.thumbnail !== null
      ? (ls.thumbnail as Record<string, unknown>)
      : null;

  const telemetry: KickTelemetry = {
    isLive: ls?.is_live === true,
    viewers: coerceViewers(ls?.viewer_count),
    title: rawTitle,
    thumbnail: typeof thumbObj?.url === "string" ? thumbObj.url : null,
    fetchedAt: new Date().toISOString(),
  };

  pruneCache();
  cache.set(key, { at: Date.now(), payload: telemetry });
  return { ok: true, telemetry, cache: { hit: false, ageSec: 0 } };
}
