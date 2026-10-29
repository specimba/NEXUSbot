import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadTinyFishKey, probeTinyFish, type TinyFishStatusPayload } from "@/lib/connectors/tinyfish";

/**
 * v37.1 — TinyFish connector status (free JS-page reader). Session-guarded.
 *
 * Probe: 1-page example.com fetch — free (fetch lane is meterless).
 */
function respond(status: TinyFishStatusPayload) {
  return NextResponse.json({ ok: true, status });
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const loaded = await loadTinyFishKey();

  if (!loaded.ok && loaded.reason === "missing") {
    return respond({
      configured: false,
      reachable: null,
      apiOk: null,
      error: null,
      credential: null,
      probedAt: null,
      sampleTitle: null,
    });
  }
  if (!loaded.ok) {
    return respond({
      configured: true,
      reachable: null,
      apiOk: null,
      error: "Stored TinyFish key is unreadable (vault key rotated out?) — re-save the key.",
      credential: null,
      probedAt: null,
      sampleTitle: null,
    });
  }

  const probe = await probeTinyFish(loaded.key);
  return respond({
    configured: true,
    ...probe,
    credential: { masked: loaded.masked, keyId: loaded.keyId, updatedAt: loaded.updatedAt },
  });
}
