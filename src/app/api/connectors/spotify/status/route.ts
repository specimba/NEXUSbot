import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { spotifyStatus } from "@/lib/connectors/spotify";

export const dynamic = "force-dynamic";

/**
 * GET /api/connectors/spotify/status — the card's state feed.
 *
 * Session-gated; returns booleans + masked previews only (P7 — no key
 * material, no tokens). The `snapshot` block is the same honest enum the
 * deterministic NOWPLAYING lane renders.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  try {
    const status = await spotifyStatus(req);
    return NextResponse.json({ ok: true, status }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const code = e instanceof Error && /VaultIntegrity/i.test(e.message) ? "VAULT_LOCKED" : "STATUS_FAILED";
    return NextResponse.json({ ok: false, error: { code, message: "Status unavailable." } }, { status: 500 });
  }
}
