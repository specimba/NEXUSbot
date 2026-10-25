import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";

/**
 * T-206 — Webshare API token storage (vault-backed, P7-safe).
 *
 * PUT  {apiToken} → upsert credential {service:"webshare", label:"api"} (AES-256-GCM).
 * DELETE          → remove it. Returns 404 when nothing was stored.
 *
 * The token is never logged, never echoed back, never stored in .env or git (P7).
 */

const SERVICE = "webshare";
const LABEL = "api";
const MIN_TOKEN_LEN = 8;
const MAX_TOKEN_LEN = 4096;

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { apiToken?: unknown } | null;

  const apiToken = typeof body?.apiToken === "string" ? body.apiToken.trim() : "";
  if (apiToken.length < MIN_TOKEN_LEN || apiToken.length > MAX_TOKEN_LEN) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "BAD_TOKEN",
          message: `apiToken must be ${MIN_TOKEN_LEN}–${MAX_TOKEN_LEN} chars`,
        },
      },
      { status: 400 },
    );
  }

  const { keyId, cipher } = encryptSecret(apiToken);

  const saved = await db.credential.upsert({
    where: { service_label: { service: SERVICE, label: LABEL } },
    create: { service: SERVICE, label: LABEL, keyId, cipher },
    update: { keyId, cipher },
  });

  return NextResponse.json(
    { ok: true, credential: { id: saved.id, service: saved.service, label: saved.label } },
    { status: 200 },
  );
}

export async function DELETE() {
  const denied = await requireSession();
  if (denied) return denied;

  const removed = await db.credential.deleteMany({
    where: { service: SERVICE, label: LABEL },
  });

  if (removed.count === 0) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "No Webshare token stored." } },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, removed: removed.count });
}
