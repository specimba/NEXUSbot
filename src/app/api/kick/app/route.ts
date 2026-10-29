import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { deleteKickConfig, revokeKickTokens, saveKickApp } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * /api/kick/app — the app credentials from the Kick Create-an-App form.
 *
 * PUT    { clientId, clientSecret } → AES-256-GCM vault upsert (service
 *        "kick", label "app"). The secret is encrypted on arrival, never
 *        echoed back — responses carry masked previews only (P7).
 * DELETE → revoke tokens (best-effort) + wipe the whole Kick vault config
 *        (app + oauth). Idempotent.
 */
function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-app:${clientKey(req)}`, 20, 60_000)) {
    return err("RATE_LIMITED", "Too many app updates — slow down.", 429);
  }

  const body = (await req.json().catch(() => null)) as { clientId?: unknown; clientSecret?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body?.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (clientId.length < 8 || clientId.length > 256) {
    return err("BAD_CLIENT_ID", "Client ID must be 8–256 characters (from the Kick Create-an-App page).", 400);
  }
  if (clientSecret.length < 8 || clientSecret.length > 256) {
    return err("BAD_CLIENT_SECRET", "Client secret must be 8–256 characters.", 400);
  }

  await saveKickApp({ clientId, clientSecret });
  return NextResponse.json(
    { ok: true, stored: true, masked: { clientIdMasked: `••••${clientId.slice(-4)}`, clientSecretMasked: "••••" } },
    { status: 201 },
  );
}

export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-app:${clientKey(req)}`, 20, 60_000)) {
    return err("RATE_LIMITED", "Too many requests — slow down.", 429);
  }

  // Best-effort revoke first (a leftover refresh token is dead weight on
  // Kick's side), then wipe the vault rows.
  await revokeKickTokens();
  const removed = await deleteKickConfig();
  return NextResponse.json({ ok: true, removed });
}
