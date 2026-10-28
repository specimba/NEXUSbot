import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { db } from "@/lib/db";
import { restoreSeal } from "@/lib/seal";

/**
 * POST /api/backup/unseal — restore a fresh sandbox from the seal
 * (body: { passphrase }). Used exactly once after a cold boot that wiped
 * .env + the DB: the sealed SESSION_SECRET/ENCRYPTION_KEY/PANEL_PASSWORD are
 * hot-applied to the running process (no restart needed — auth.ts re-reads
 * SESSION_SECRET per call and reloadVaultKeys() re-derives the AES cache),
 * persisted to .env for future boots, and the vault/widget/settings/token
 * rows are upserted back into the DB.
 *
 * Session-gated AND rate-limited hard (the passphrase is the only secret).
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`unseal:${clientKey(req)}`, 5, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many restore attempts — wait a minute." } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { passphrase?: unknown } | null;
  const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";

  try {
    const result = await restoreSeal(passphrase);

    // L0 event so the Stream tab records the restore; a fresh mirror probe
    // happens naturally on the next status read (widget variables are back).
    await db.event
      .create({
        data: {
          source: "system",
          type: "durability.seal_restored",
          level: "info",
          actor: "panel",
          payload: JSON.stringify({
            sealedAt: result.sealedAt,
            credentials: result.credentials,
            widgets: result.widgets,
            settings: result.settings,
            ingestTokens: result.ingestTokens,
          }),
        },
      })
      .catch(() => undefined);

    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const notFound = message.includes("ENOENT");
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: notFound ? "NO_SEAL" : "RESTORE_FAILED",
          message: notFound
            ? "No seal file exists yet — seal the panel first (Settings → Sandbox seal)."
            : message,
        },
      },
      { status: notFound ? 404 : 400 },
    );
  }
}
