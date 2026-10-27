import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { kickSendBotMessage, loadKickOAuth } from "@/lib/connectors/kick";

export const dynamic = "force-dynamic";

/**
 * POST /api/kick/test-chat — send one test bot message to the connected
 * channel (verifies chat:write + the token, end to end, with the owner's
 * own eyes on kick.com). Body optional: { content?: string } (≤480 chars).
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`kick-testchat:${clientKey(req)}`, 6, 60_000)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Max 6 test messages per minute." } }, { status: 429 });
  }

  const oauth = await loadKickOAuth();
  if (!oauth) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_CONNECTED", message: "Connect a Kick account first." } },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { content?: unknown };
  const content =
    typeof body.content === "string" && body.content.trim()
      ? body.content.trim().slice(0, 480)
      : "VYCE hattı canlı — Kick bağlantısı kuruldu 🛰";

  const res = await kickSendBotMessage(content);
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: { code: res.code ?? "SEND_FAILED", message: "Kick did not accept the message." } },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, sent: true, messageId: res.messageId ?? null });
}
