import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadAgentMailKey, listAgentMailThreads } from "@/lib/connectors/agentmail";

/**
 * v37.3 — AgentMail threads feed. Session-guarded.
 *
 * GET ?limit=10 → latest threads (first-class on the platform; org-wide
 * search exists server-side). Completes the promised "send/list/threads/armor"
 * API surface (docs/agentmail-deep-dive.md §4.3).
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

  const feed = await listAgentMailThreads(loaded.key, limit);
  if (!feed.ok) {
    return NextResponse.json({ ok: false, error: feed.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...feed.data });
}
