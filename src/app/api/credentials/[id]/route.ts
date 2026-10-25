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
  const existing = await db.credential.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Credential not found" } },
      { status: 404 },
    );
  }

  await db.credential.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
