import { db } from "@/lib/db";

/**
 * NEXUS OS — seal passphrase cache + debounced auto-reseal (2026-10-29 fix).
 *
 * THE INCIDENT (measured, 2026-10-29): the last seal was written at 19:15:14 +03
 * and the owner's OBS ingest token was minted ~60s later, AFTER the seal and
 * outside any snapshot. The 19:20 wipe killed it — restored state was missing
 * exactly the rows that changed after the last seal. The seal only ever
 * refreshed when the owner remembered to re-seal manually.
 *
 * THE FIX: when the owner unseals (POST /api/backup/unseal → restoreSeal), the
 * verified passphrase is cached in-process (globalThis holder, survives HMR).
 * From then on, the Prisma extension in src/lib/db.ts schedules a DEBOUNCED
 * reseal after every successful mutation of the four seal-carried models
 * (Credential / IngestToken / Widget / Setting). The seal therefore tracks the
 * live vault state automatically — a post-seal token can never again be lost
 * to a wipe, because the wipe can at most cost the debounce window (45 s).
 *
 * Security posture (deliberate, stated honestly):
 *   - The cache lives ONLY in this server process's memory. A cold boot — the
 *     exact event the seal protects against — never sees it; the owner's
 *     passphrase input at the next unseal re-primes it.
 *   - It is never logged, returned, or persisted (P7).
 *   - Reseal is best-effort and fire-and-forget: it must never delay or fail
 *     the mutation that triggered it. Failures are recorded as honest
 *     durability.seal_auto_refresh_failed Event rows.
 *   - createSeal() refuses to seal an empty payload, so a wiped-fresh boot
 *     with a primed cache (impossible in practice) still cannot destroy a
 *     good seal with garbage.
 */
import type { SealMeta } from "@/lib/seal";

type SealCacheState = {
  passphrase: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastResealAt: number;
  lastError: string | null;
};

const globalForSealCache = globalThis as unknown as {
  __nexusSealCache?: SealCacheState | undefined;
};

const state: SealCacheState =
  globalForSealCache.__nexusSealCache ??
  { passphrase: null, timer: null, lastResealAt: 0, lastError: null };
globalForSealCache.__nexusSealCache = state;

/** Debounce window — coalesces bursts of vault mutations into one reseal. */
const DEBOUNCE_MS = 45_000;

/** Called by restoreSeal() after a successful passphrase check. Never logged. */
export function cacheSealPassphrase(passphrase: string): void {
  state.passphrase = passphrase;
}

/** Whether the in-process cache can reseal (panel diagnostics use). */
export function sealPassphraseCached(): boolean {
  return state.passphrase !== null;
}

/** Last auto-reseal outcome for diagnostics — no secret material. */
export function sealAutoResealState(): {
  cached: boolean;
  lastResealAt: number;
  lastError: string | null;
} {
  return {
    cached: state.passphrase !== null,
    lastResealAt: state.lastResealAt,
    lastError: state.lastError,
  };
}

/**
 * Schedule a debounced reseal. No-op without a cached passphrase (fresh boot,
 * or the owner never unsealed) — in that case manual sealing remains the only
 * path, exactly as before.
 */
export function scheduleReseal(trigger: string): void {
  if (state.passphrase === null) return;
  if (state.timer !== null) return; // already scheduled — coalesce the burst
  state.timer = setTimeout(() => {
    state.timer = null;
    void runReseal(trigger);
  }, DEBOUNCE_MS);
  state.timer.unref?.();
}

async function runReseal(trigger: string): Promise<void> {
  const passphrase = state.passphrase;
  if (passphrase === null) return;
  try {
    // Dynamic import: seal.ts reads the DB via the same extended client —
    // by the time any mutation runs, both modules are fully initialized.
    const { createSeal } = await import("@/lib/seal");
    const meta: SealMeta = await createSeal(passphrase);
    state.lastResealAt = Date.now();
    state.lastError = null;
    await db.event
      .create({
        data: {
          source: "system",
          type: "durability.seal_auto_refreshed",
          level: "info",
          actor: "panel",
          payload: JSON.stringify({
            trigger,
            sealedAt: meta.sealedAt,
            counts: meta.counts,
          }),
        },
      })
      .catch(() => undefined); // telemetry must never fail the reseal
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    await db.event
      .create({
        data: {
          source: "system",
          type: "durability.seal_auto_refresh_failed",
          level: "error",
          actor: "panel",
          payload: JSON.stringify({
            trigger,
            message: state.lastError.slice(0, 500),
          }),
        },
      })
      .catch(() => undefined); // honest, loud in the Stream tab, never fatal
  }
}
