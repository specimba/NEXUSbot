import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadKeenableKey, probeKeenable, type KeenableStatusPayload } from "@/lib/connectors/keenable";

/**
 * v37.1 — Keenable connector status (the FREE research lane). Session-guarded.
 *
 * Probe: one 2-result search — proves key + endpoint + shape in a single call
 * (burns 1 of the 100k free requests; honest about that in the card copy).
 */
function respond(status: KeenableStatusPayload) {
  return NextResponse.json({ ok: true, status });
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const loaded = await loadKeenableKey();

  if (!loaded.ok && loaded.reason === "missing") {
    return respond({
      configured: false,
      reachable: null,
      apiOk: null,
      error: null,
      credential: null,
      probedAt: null,
      sampleResultCount: null,
    });
  }
  if (!loaded.ok) {
    return respond({
      configured: true,
      reachable: null,
      apiOk: null,
      error: "Stored Keenable key is unreadable (vault key rotated out?) — re-save the key.",
      credential: null,
      probedAt: null,
      sampleResultCount: null,
    });
  }

  const probe = await probeKeenable(loaded.key);
  return respond({
    configured: true,
    ...probe,
    credential: { masked: loaded.masked, keyId: loaded.keyId, updatedAt: loaded.updatedAt },
  });
}
