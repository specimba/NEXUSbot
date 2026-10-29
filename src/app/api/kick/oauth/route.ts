import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { deleteKickOAuth, revokeKickTokens } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/kick/oauth — disconnect the Kick ACCOUNT (keep app creds).
 *
 * Revokes the stored access + refresh tokens at id.kick.com (best-effort —
 * a network failure must not block the local wipe), then removes the oauth
 * vault row. The app credentials stay so reconnecting is one click.
 */
export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-oauth:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  await revokeKickTokens();
  await deleteKickOAuth();
  return NextResponse.json({ ok: true, disconnected: true });
}
