import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadAgentMailKey, agentMailSend } from "@/lib/connectors/agentmail";

/**
 * v37.1 — AgentMail send lane (panel test send). Session-guarded.
 *
 * POST { to, subject, text } → /v0/inboxes/{id}/messages/send.
 * The response carries only message_id/thread_id + latency — never the key.
 * Free-tier posture is honest: 100 sends/day (unused capacity for a bot).
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as
    | { to?: unknown; subject?: unknown; text?: unknown }
    | null;

  const loaded = await loadAgentMailKey();
  if (!loaded.ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          loaded.reason === "missing"
            ? "AgentMail key not configured (vault)."
            : "Stored AgentMail key is unreadable — re-save the key.",
      },
      { status: loaded.reason === "missing" ? 404 : 500 }
    );
  }

  const sent = await agentMailSend(loaded.key, {
    to: String(body?.to ?? ""),
    subject: String(body?.subject ?? ""),
    text: String(body?.text ?? ""),
  });
  if (!sent.ok) {
    return NextResponse.json({ ok: false, error: sent.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, sent: sent.data });
}
