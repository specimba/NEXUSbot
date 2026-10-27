/**
 * v31.4 — the /api/vyce/status probe verdict cache.
 *
 * Owner report (2026-10-28): "page giving OOM error freeze constantly".
 * dev.log measured this route taking 10-18s per call (a live 10-model probe)
 * while the Connectors card polls every ~30s — every visit hung the panel on
 * a serial upstream probe. The full verdict is now cached for 90s; saving or
 * deleting a key (/api/vyce/key) invalidates the cache instantly so a fresh
 * key is reflected on the very next poll. globalThis keeps the cache across
 * Turbopack dev hot-reloads (same pattern as the cortex stores).
 */

type Entry = { at: number; body: Record<string, unknown> };

const g = globalThis as typeof globalThis & { __nexusVyceStatusCache?: Entry };
const TTL_MS = 90_000;

export function readVyceStatusCache(): Record<string, unknown> | null {
  const e = g.__nexusVyceStatusCache;
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    g.__nexusVyceStatusCache = undefined;
    return null;
  }
  return e.body;
}

export function writeVyceStatusCache(body: Record<string, unknown>): void {
  g.__nexusVyceStatusCache = { at: Date.now(), body };
}

export function invalidateVyceStatusCache(): void {
  g.__nexusVyceStatusCache = undefined;
}
