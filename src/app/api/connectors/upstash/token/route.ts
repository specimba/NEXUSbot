import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import {
  UPSTASH_LABEL,
  UPSTASH_SERVICE,
  UpstashConnectorError,
  validateUpstashUrl,
} from "@/lib/connectors/upstash";

const MAX_URL_LEN = 2048;
const MAX_TOKEN_LEN = 4096;

/**
 * T-204 Upstash REST credential management. Auth: panel session.
 *
 * PUT {url, token} → validated, stored as JSON {"url","token"} in the encrypted
 * vault (service "upstash", label "rest") via upsert — re-saving replaces the
 * previous value. DELETE removes the credential (idempotent).
 *
 * P7: request values are never echoed back in any response, never logged, and
 * never persisted outside the AES-256-GCM envelope.
 */
export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { url?: unknown; token?: unknown }
    | null;

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  if (!url || !token) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_INPUT", message: "Both `url` and `token` are required and must be non-empty" },
      },
      { status: 400 },
    );
  }
  if (url.length > MAX_URL_LEN || token.length > MAX_TOKEN_LEN) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_INPUT", message: "`url` (≤2048) or `token` (≤4096) exceeds length limit" },
      },
      { status: 400 },
    );
  }

  try {
    validateUpstashUrl(url);
  } catch (e) {
    const message =
      e instanceof UpstashConnectorError ? e.message : "REST URL is invalid";
    return NextResponse.json(
      { ok: false, error: { code: "BAD_URL", message } },
      { status: 400 },
    );
  }

  const { keyId, cipher } = encryptSecret(JSON.stringify({ url, token }));

  await db.credential.upsert({
    where: { service_label: { service: UPSTASH_SERVICE, label: UPSTASH_LABEL } },
    create: { service: UPSTASH_SERVICE, label: UPSTASH_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });

  // Deliberately minimal response — no echo of url or token (P7).
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const denied = await requireSession();
  if (denied) return denied;

  const existing = await db.credential.findUnique({
    where: { service_label: { service: UPSTASH_SERVICE, label: UPSTASH_LABEL } },
  });

  if (existing) {
    await db.credential.delete({ where: { id: existing.id } });
  }

  // Idempotent disconnect: 200 even when nothing was stored.
  return NextResponse.json({ ok: true, removed: Boolean(existing) });
}
