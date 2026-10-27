import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { getKickChatReplies, setKickChatReplies } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * PUT /api/kick/replies — toggle whether webhook-ingested !ai prompts get
 * their VYCE answers posted back into the live Kick chat. Default ON (that
 * is the connection's purpose); the overlay widget always shows replies
 * regardless of this toggle.
 */
export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-replies:${clientKey(req)}`, 20, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_BODY", message: "`enabled` boolean required." } },
      { status: 400 },
    );
  }

  await setKickChatReplies(body.enabled);
  return NextResponse.json({ ok: true, enabled: body.enabled });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const enabled = await getKickChatReplies();
  return NextResponse.json({ ok: true, enabled });
}
