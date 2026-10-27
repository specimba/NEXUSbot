/**
 * NEXUS OS — in-process TTL cache for live connector probes (M2-R perf pass).
 *
 * WHY: every panel mount / 30-60s poll used to fire a REAL outbound HTTPS probe
 * per connector (up to 11 upstream calls for Supabase health alone). In dev the
 * panel is polled by widgets and re-mounted on every tab flip — an external-API
 * storm that burns server RAM/CPU and the connectors' own rate budgets.
 *
 * CONTRACT: a cached result is still MEASURED — each entry carries `probedAt`
 * and the UI displays it, so the panel never shows a stale number as fresh.
 * Mutation routes (save/delete credential) invalidate their prefix so the next
 * read always probes with the new credential. `fresh=1` requests bypass the
 * cache (the cards' refresh buttons send it).
 *
 * Scale: single dev process, a handful of keys — a plain Map is the whole
 * "caching layer" (per stack rules: local memory, no Redis).
 */

type Entry = { at: number; value: unknown };

const store = new Map<string, Entry>();

/** Hard cap so a runaway key space can never grow unbounded. */
const MAX_ENTRIES = 64;

export type CachedProbeResult<T> = {
  value: T;
  probedAt: string;
  cached: boolean;
};

/**
 * Return the cached probe if younger than `ttlMs`, else run the fetcher,
 * cache it, and return it. Never throws for cache reasons; fetcher errors
 * propagate to the caller (routes already map them to honest payloads).
 */
export async function cachedProbe<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<CachedProbeResult<T>> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < ttlMs) {
    return { value: hit.value as T, probedAt: new Date(hit.at).toISOString(), cached: true };
  }

  const value = await fetcher();
  // Simple size guard: drop the oldest entry when full.
  if (store.size >= MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of store) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, { at: now, value });
  return { value, probedAt: new Date(now).toISOString(), cached: false };
}

/** Drop cache entries whose key starts with `prefix` (e.g. "supabase:"). */
export function invalidateProbeCache(prefix: string): number {
  let removed = 0;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.delete(k);
      removed++;
    }
  }
  return removed;
}

/** Test/ops helper — current cache size. */
export function probeCacheSize(): number {
  return store.size;
}

/** True when the request asks to bypass the cache (?fresh=1). */
export function wantsFresh(req: Request): boolean {
  const v = new URL(req.url).searchParams.get("fresh");
  return v === "1" || v === "true";
}
