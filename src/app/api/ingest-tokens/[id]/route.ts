import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { id } = await params;
  const token = await db.ingestToken.findUnique({ where: { id } });
  if (!token) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Token not found" } },
      { status: 404 },
    );
  }

  await db.ingestToken.update({ where: { id }, data: { revokedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
