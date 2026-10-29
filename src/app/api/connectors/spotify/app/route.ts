import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { deleteSpotifyApp, loadSpotifyApp, saveSpotifyApp } from "@/lib/connectors/spotify";

export const dynamic = "force-dynamic";

/**
 * PUT /api/connectors/spotify/app — store the Spotify app Client ID.
 *
 * PKCE public client: NO client secret is ever requested or stored — the
 * least-privilege posture (read-only playback scopes). 8–200 chars, the
 * Spotify Client ID format (32 hex chars in practice, kept permissive).
 */
export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`spotify-app:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { clientId?: unknown } | null;
  const clientId = String(body?.clientId ?? "").trim();
  if (!/^[a-z0-9]{8,}$/i.test(clientId) || clientId.length > 200) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_CLIENT_ID", message: "Spotify Client ID looks wrong — paste it from the dashboard." } },
      { status: 400 },
    );
  }

  await saveSpotifyApp({ clientId });
  const app = await loadSpotifyApp();
  return NextResponse.json({ ok: true, saved: true });
}

/** DELETE /api/connectors/spotify/app — remove the app record (idempotent). */
export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`spotify-app-del:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }
  const count = await deleteSpotifyApp();
  return NextResponse.json({ ok: true, deleted: count });
}
