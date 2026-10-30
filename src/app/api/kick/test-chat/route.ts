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
      : "VYCE hattı canlı — Kick bağlantısı kuruldu.";

  // v38 — no allowDuplicate escape hatch on purpose: a manual re-test of the
  // SAME line inside 60s is exactly the double-post class the guard exists
  // for. The response says so honestly instead of pretending a fresh send.
  const res = await kickSendBotMessage(content);
  if (!res.ok) {
    // Surface the REAL Kick rejection (e.g. "HTTP_422: chatroom_id required")
    // instead of a bare label — the owner can act on it without log access.
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: res.code ?? "SEND_FAILED",
          message: res.code ? `Kick did not accept the message (${res.code}).` : "Kick did not accept the message.",
        },
      },
      { status: 502 },
    );
  }
  if (res.deduped) {
    return NextResponse.json({
      ok: true,
      sent: false,
      deduped: true,
      messageId: res.messageId ?? null,
      identity: res.identity ?? null,
      note: "Identical content was already delivered in the last 60s — duplicate suppressed.",
    });
  }
  return NextResponse.json({ ok: true, sent: true, deduped: false, messageId: res.messageId ?? null, identity: res.identity ?? null });
}
