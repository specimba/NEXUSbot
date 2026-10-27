/**
 * Tiny in-memory rate limiter (panel scale only — single operator, local memory
 * per the caching convention: no Redis/middleware).
 */

const hits = new Map<string, { count: number; reset: number }>();

export function rateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  // Self-pruning (v31.3): pruneRateLimits() was only ever called from the
  // login route, so the map grew with every unique key for the life of the
  // process. Opportunistic sweep keeps it bounded from the hot path itself.
  if (hits.size > 512) pruneRateLimits();
  const h = hits.get(key);
  if (!h || now > h.reset) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (h.count >= limit) return false;
  h.count += 1;
  return true;
}

/** Opportunistic prune so the map cannot grow unbounded. */
export function pruneRateLimits(): void {
  const now = Date.now();
  if (hits.size < 512) return;
  for (const [k, v] of hits) {
    if (now > v.reset) hits.delete(k);
  }
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
