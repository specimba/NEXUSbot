import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadAgentMailKey, listAgentMailInbox } from "@/lib/connectors/agentmail";

/**
 * v37.1 — AgentMail inbox feed (pull-based). Session-guarded.
 *
 * GET ?limit=10 → latest messages with Agent Armor verdict badges.
 * Deliberately pull-only: the public-URL webhook decision is parked
 * (docs/agentmail-deep-dive.md §4.2) — no inbound push until Hold mode +
 * sender allowlists are wired.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "10");

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

  const feed = await listAgentMailInbox(loaded.key, limit);
  if (!feed.ok) {
    return NextResponse.json(
      { ok: false, error: feed.error },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, ...feed.data });
}
