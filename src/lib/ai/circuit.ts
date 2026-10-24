/**
 * NEXUS OS — per-provider circuit breaker (task R19-a).
 *
 * Owner complaint being fixed: "That probe or pinging should be smarter than
 * this spamming, exhaustion-style approach, especially against
 * aihubmix-like fragile-limits providers." [MEASURED evidence: 5 chat calls to
 * custom provider aihubmixfree hit RATE_LIMITED within ~90s — two only 200ms
 * apart — with zero backoff; and GET /api/vyce/status live-probed the Supabase
 * EF relay (18s budget) on EVERY panel poll (~30s), each burning a 15s
 * Vyce-origin attempt while Vyce sat in maintenance.]
 *
 * This module is a pure IN-MEMORY circuit breaker over provider keys:
 *   "vyce"            — the Vyce gateway chat paths (client.ts)
 *   "groq"            — the Groq slot chat paths (client.ts)
 *   "custom:<slug>"   — each custom provider (custom-providers.ts)
 *
 * SEMANTICS (half-open breaker):
 * - checkCircuit(key): open while now < openUntilMs. After the cooldown
 *   expires the circuit reports closed — the NEXT call is a TRIAL; a trial
 *   success closes the circuit fully (failure counter resets), a trial failure
 *   re-opens it at the NEXT step of the schedule (consecutive failures advance
 *   the step, capped).
 * - Cooldown schedule by failure CLASS (the latest class decides the schedule;
 *   the consecutive-failure count decides the step inside it):
 *     RATE_LIMITED                        60s → 120s → 300s → 900s (cap)
 *     KEY_REJECTED / UNAUTHORIZED         600s flat (key problems don't heal
 *                                          by hammering — 10 minutes of quiet)
 *     transport/timeout/UNREACHABLE       30s → 60s → 120s
 *     BAD_RESPONSE                        60s → 180s → 600s
 *     anything else (incl. NO_KEY)        60s flat
 * - NO new dependencies, no timers, no persistence: state is a plain Map that
 *   resets with the process (a fresh process honestly starts with fresh
 *   trials). circuitSnapshot() exposes plain data (no secrets — keys are
 *   provider names/slugs, which are config) for future UI use.
 */

export type CircuitKey = "vyce" | "groq" | `custom:${string}`;

export type CircuitState = {
  /** Consecutive failures (drives the step inside the class schedule). */
  failures: number;
  /** Epoch ms until which the circuit is open; 0 = closed. */
  openUntilMs: number;
  /** Last recorded failure class (e.g. RATE_LIMITED, KEY_REJECTED). */
  lastErrorClass: string | null;
  /** Epoch ms of the last recorded failure. */
  lastErrorAt: number | null;
  /** Epoch ms of the last recorded success. */
  lastOkAt: number | null;
};

export type CircuitCheck = {
  open: boolean;
  /** Milliseconds until the cooldown expires (0 when closed / already expired). */
  retryInMs: number;
  lastErrorClass: string | null;
  /** ISO timestamp of the last recorded failure. */
  lastErrorAt: string | null;
};

export type CircuitSnapshotEntry = {
  key: string;
  state: "closed" | "open" | "half-open";
  failures: number;
  retryInMs: number;
  lastErrorClass: string | null;
  lastErrorAt: string | null;
  lastOkAt: string | null;
};

/** Cooldown schedules per failure class (ms). Capped by the last entry. */
const CIRCUIT_SCHEDULES: Readonly<Record<string, readonly number[]>> = {
  // Fragile-limit providers: give them real time to refill.
  RATE_LIMITED: [60_000, 120_000, 300_000, 900_000],
  // Key problems don't heal by hammering — flat 10 minutes of quiet.
  KEY_REJECTED: [600_000],
  UNAUTHORIZED: [600_000],
  // Transport/timeout/outage-class: short probes are cheap, retry sooner.
  UNREACHABLE_FROM_SANDBOX: [30_000, 60_000, 120_000],
  NETWORK_ERROR: [30_000, 60_000, 120_000],
  TIMEOUT: [30_000, 60_000, 120_000],
  // Upstream answered, but badly (5xx, junk payloads).
  BAD_RESPONSE: [60_000, 180_000, 600_000],
};

/** Unknown classes (incl. NO_KEY — a config gap, not upstream hostility). */
const CIRCUIT_UNKNOWN_SCHEDULE: readonly number[] = [60_000];

const circuits = new Map<CircuitKey, CircuitState>();

function scheduleFor(errorClass: string): readonly number[] {
  return CIRCUIT_SCHEDULES[errorClass] ?? CIRCUIT_UNKNOWN_SCHEDULE;
}

function cooldownMs(errorClass: string, failures: number): number {
  const schedule = scheduleFor(errorClass);
  const step = Math.min(Math.max(failures, 1), schedule.length); // 1-based, capped
  return schedule[step - 1];
}

/**
 * Current breaker verdict for a provider key. Pure read — no state transition;
 * after the cooldown expires this reports open:false, which MAKES the next
 * call the half-open trial (its outcome then closes or re-opens the circuit).
 */
export function checkCircuit(key: CircuitKey): CircuitCheck {
  const state = circuits.get(key);
  const lastErrorAt = state?.lastErrorAt !== null && state?.lastErrorAt !== undefined
    ? new Date(state.lastErrorAt).toISOString()
    : null;
  if (!state || state.openUntilMs <= 0) {
    return { open: false, retryInMs: 0, lastErrorClass: state?.lastErrorClass ?? null, lastErrorAt };
  }
  const now = Date.now();
  const retryInMs = Math.max(0, state.openUntilMs - now);
  return {
    open: retryInMs > 0,
    retryInMs,
    lastErrorClass: state.lastErrorClass,
    lastErrorAt,
  };
}

/** A successful call closes the circuit fully: failures reset, cooldown cleared. */
export function recordCircuitSuccess(key: CircuitKey): void {
  const state = circuits.get(key);
  const now = Date.now();
  if (!state) {
    circuits.set(key, { failures: 0, openUntilMs: 0, lastErrorClass: null, lastErrorAt: null, lastOkAt: now });
    return;
  }
  state.failures = 0;
  state.openUntilMs = 0;
  state.lastOkAt = now;
}

/**
 * A failed call advances the breaker: consecutive-failure count +1 (capped by
 * the schedule length) and the circuit opens for the class schedule's step.
 * The LATEST class picks the schedule; the count picks the step inside it.
 */
export function recordCircuitFailure(key: CircuitKey, errorClass: string): void {
  const state = circuits.get(key);
  const now = Date.now();
  const failures = (state?.failures ?? 0) + 1;
  const schedule = scheduleFor(errorClass);
  const cappedFailures = Math.min(failures, schedule.length);
  circuits.set(key, {
    failures: cappedFailures,
    openUntilMs: now + cooldownMs(errorClass, cappedFailures),
    lastErrorClass: errorClass,
    lastErrorAt: now,
    lastOkAt: state?.lastOkAt ?? null,
  });
}

/** Plain-data snapshot for future UI use. No secrets — keys are provider config. */
export function circuitSnapshot(): CircuitSnapshotEntry[] {
  const now = Date.now();
  const out: CircuitSnapshotEntry[] = [];
  for (const [key, state] of circuits) {
    const retryInMs = Math.max(0, state.openUntilMs - now);
    out.push({
      key,
      state: retryInMs > 0 ? "open" : state.failures > 0 ? "half-open" : "closed",
      failures: state.failures,
      retryInMs,
      lastErrorClass: state.lastErrorClass,
      lastErrorAt: state.lastErrorAt !== null ? new Date(state.lastErrorAt).toISOString() : null,
      lastOkAt: state.lastOkAt !== null ? new Date(state.lastOkAt).toISOString() : null,
    });
  }
  return out;
}
