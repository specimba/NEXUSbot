import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const [eventsTotal, tokensActive, credentialsTotal] = await Promise.all([
    db.event.count(),
    db.ingestToken.count({ where: { revokedAt: null } }),
    db.credential.count(),
  ]);

  return NextResponse.json({
    ok: true,
    stats: {
      eventsTotal,
      tokensActive,
      credentialsTotal,
      uptimeSec: Math.round(process.uptime()),
    },
  });
}
