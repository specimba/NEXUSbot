import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";

const SERVICES = new Set(["github", "supabase", "upstash", "hyperbrowser", "webshare"]);

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const url = new URL(req.url);
  const service = url.searchParams.get("service");

  const rows = await db.credential.findMany({
    where: service ? { service } : undefined,
    orderBy: { updatedAt: "desc" },
  });

  // Values are decrypted transiently ONLY to build the masked preview —
  // plaintext never leaves the process (P7).
  const credentials = rows.map((r) => {
    let masked = "••••";
    try {
      masked = maskSecret(decryptSecret(r.cipher));
    } catch {
      masked = "⚠ unreadable (key rotated out?)";
    }
    return {
      id: r.id,
      service: r.service,
      label: r.label,
      keyId: r.keyId,
      masked,
      updatedAt: r.updatedAt,
    };
  });

  return NextResponse.json({ ok: true, credentials });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { service?: unknown; label?: unknown; secret?: unknown }
    | null;

  const service = String(body?.service ?? "").trim();
  if (!SERVICES.has(service)) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_SERVICE", message: `service must be one of ${[...SERVICES].join(", ")}` } },
      { status: 400 },
    );
  }

  const secret = typeof body?.secret === "string" ? body.secret : "";
  if (secret.length < 8 || secret.length > 4096) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_SECRET", message: "secret must be 8–4096 chars" } },
      { status: 400 },
    );
  }

  const label = String(body?.label ?? "default").trim().slice(0, 48) || "default";
  const { keyId, cipher } = encryptSecret(secret);

  const saved = await db.credential.upsert({
    where: { service_label: { service, label } },
    create: { service, label, keyId, cipher },
    update: { keyId, cipher },
  });

  return NextResponse.json(
    { ok: true, credential: { id: saved.id, service: saved.service, label: saved.label } },
    { status: 201 },
  );
}
