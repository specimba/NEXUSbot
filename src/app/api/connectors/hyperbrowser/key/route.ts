import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { HYPERBROWSER_LABEL, HYPERBROWSER_SERVICE } from "@/lib/connectors/hyperbrowser";

/**
 * T-205 — Hyperbrowser API key management (vault-backed). Session-guarded.
 *
 * PUT  { apiKey } → AES-256-GCM vault upsert (service "hyperbrowser", label "default").
 * DELETE          → removes the stored credential.
 *
 * P7: the key value is never echoed back, never logged, never stored in .env.
 * Only a masked preview (last 4 chars) is returned.
 */

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

  if (apiKey.length < 8 || apiKey.length > 4096) {
    return badRequest("BAD_API_KEY", "apiKey must be 8–4096 characters");
  }

  const { keyId, cipher } = encryptSecret(apiKey);

  const saved = await db.credential.upsert({
    where: { service_label: { service: HYPERBROWSER_SERVICE, label: HYPERBROWSER_LABEL } },
    create: { service: HYPERBROWSER_SERVICE, label: HYPERBROWSER_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });

  return NextResponse.json({
    ok: true,
    credential: {
      id: saved.id,
      service: saved.service,
      label: saved.label,
      keyId: saved.keyId,
      masked: maskSecret(apiKey),
    },
  });
}

export async function DELETE() {
  const denied = await requireSession();
  if (denied) return denied;

  const removed = await db.credential.deleteMany({
    where: { service: HYPERBROWSER_SERVICE, label: HYPERBROWSER_LABEL },
  });

  // Idempotent: removing an absent credential is still a success.
  return NextResponse.json({ ok: true, removed: removed.count });
}
