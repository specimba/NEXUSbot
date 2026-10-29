import { createHash } from "node:crypto";

/**
 * v35 RSI Lab — hash conventions (matches src/lib/seal.ts + docs/verify.md
 * artifact-integrity practice; design source eval-design.json auditChain).
 *
 * Chain rule (G8): eventHash = sha256(prevHash + canonical_json(payload)) with
 * canonical JSON = stable key sort. Replay-verifiable in O(n), zero secrets.
 */

/** Stable-key-sort JSON serialization (canonical form for hashing). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, sort(o[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Chain hash: sha256 hex of prevHash + canonical JSON of the payload. */
export function chainHash(prevHash: string, payload: unknown): string {
  return createHash("sha256").update(prevHash + canonicalJson(payload), "utf8").digest("hex");
}

/** Plain sha256 hex of a string (suite configHash sealing). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Genesis prev-hash for the first event of every chain. */
export const GENESIS_HASH = "";
