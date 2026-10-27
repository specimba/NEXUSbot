// Ingest rate limiting — FR-01 / RT-02 (frozen limits).
//
// Single-process in-memory sliding windows: fine for the single-operator panel
// (scope §6). Two windows per IP: 60s (30 req/min) and 1s (burst 5 req/s).
// Sustained overload (>90 req/min = 3× limit) → shed=true → API answers 503.
//
// This module is ingest-only per T-102 scope; login throttling lives in T-107.

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the next slot frees (min 1, ceil) when not allowed; 0 when allowed. */
  retryAfterS: number
  /** True when sustained overload detected → caller must answer 503. */
  shed: boolean
}

interface IpWindows {
  /** Timestamps (ms) of requests inside the current 60s window. */
  minute: number[]
  /** Timestamps (ms) of requests inside the current 1s window. */
  second: number[]
  lastSeen: number
}

// Frozen limits (FR-01).
const MINUTE_LIMIT = 30
const BURST_LIMIT = 5
const SHED_THRESHOLD = 90 // 3× minute limit
const MINUTE_MS = 60_000
const BURST_MS = 1_000
const IP_TTL_MS = 10 * 60_000 // drop IPs unseen > 10 min (memory cap)

// globalThis holder survives Next.js HMR module reloads.
const globalForRatelimit = globalThis as unknown as {
  __nexusRateLimitStore: Map<string, IpWindows> | undefined
  __nexusRateLimitCalls: number | undefined
}

const store: Map<string, IpWindows> =
  globalForRatelimit.__nexusRateLimitStore ?? new Map()
globalForRatelimit.__nexusRateLimitStore = store

let callCount = globalForRatelimit.__nexusRateLimitCalls ?? 0

/** Prune the store opportunistically — no timers, no leaks. */
function sweepStale(now: number): void {
  callCount += 1
  globalForRatelimit.__nexusRateLimitCalls = callCount
  // Sweep on every 32nd call or when the map grows past 1024 entries.
  if (callCount % 32 !== 0 && store.size <= 1024) return
  for (const [ip, w] of store) {
    if (now - w.lastSeen > IP_TTL_MS) store.delete(ip)
  }
}

function pruneWindow(buf: number[], now: number, windowMs: number): void {
  const cutoff = now - windowMs
  // Timestamps are pushed in non-decreasing order; drop from the front.
  while (buf.length > 0 && buf[0] <= cutoff) buf.shift()
}

/**
 * Sliding-window check for POST /api/events. Records the request when allowed.
 * Callers must NOT record when rejected (a rejected request occupies no slots,
 * so retryAfterS is exact for the next accepted request).
 */
export function checkIngestRateLimit(ip: string): RateLimitResult {
  const now = Date.now()
  sweepStale(now)

  let w = store.get(ip)
  if (!w) {
    w = { minute: [], second: [], lastSeen: now }
    store.set(ip, w)
  }
  w.lastSeen = now
  pruneWindow(w.minute, now, MINUTE_MS)
  pruneWindow(w.second, now, BURST_MS)

  // Retry horizon if the minute window is the binding constraint.
  const minuteRetryS = Math.max(
    1,
    Math.ceil((w.minute[0] + MINUTE_MS - now) / 1000),
  )
  // Retry horizon if the burst window is the binding constraint.
  const burstRetryS = Math.max(
    1,
    Math.ceil((w.second[0] + BURST_MS - now) / 1000),
  )

  // Sustained overload → shed (503). Checked first: takes precedence.
  if (w.minute.length > SHED_THRESHOLD) {
    return { allowed: false, retryAfterS: minuteRetryS, shed: true }
  }

  // Minute limit hit → 429.
  if (w.minute.length >= MINUTE_LIMIT) {
    return { allowed: false, retryAfterS: minuteRetryS, shed: false }
  }

  // Burst limit hit → 429. When both windows are saturated, wait for the
  // slower one to free a slot (the max horizon is the honest answer).
  if (w.second.length >= BURST_LIMIT) {
    return {
      allowed: false,
      retryAfterS: w.minute.length >= MINUTE_LIMIT ? minuteRetryS : burstRetryS,
      shed: false,
    }
  }

  // Accepted — record occupancy in both windows.
  w.minute.push(now)
  w.second.push(now)
  return { allowed: true, retryAfterS: 0, shed: false }
}

/** Test/introspection helper: current occupancy for one IP (minute window). */
export function getRateLimitSnapshot(ip: string): {
  minuteCount: number
  burstCount: number
} {
  const now = Date.now()
  const w = store.get(ip)
  if (!w) return { minuteCount: 0, burstCount: 0 }
  pruneWindow(w.minute, now, MINUTE_MS)
  pruneWindow(w.second, now, BURST_MS)
  return { minuteCount: w.minute.length, burstCount: w.second.length }
}
