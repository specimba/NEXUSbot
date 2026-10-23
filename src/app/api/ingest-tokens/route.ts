import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const tokens = await db.ingestToken.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      preview: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });

  return NextResponse.json({ ok: true, tokens });
}

/** Creates an ingest token. Plaintext returned ONCE; only sha256 hash is stored. */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
  const label = String(body?.label ?? "").trim().slice(0, 48) || "default";

  const token = `nxi_${randomBytes(24).toString("base64url")}`;
  const created = await db.ingestToken.create({
    data: {
      label,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      preview: `${token.slice(0, 8)}…`,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      token, // shown once — never retrievable again
      record: { id: created.id, label: created.label, preview: created.preview },
    },
    { status: 201 },
  );
}
