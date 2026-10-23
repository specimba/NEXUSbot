import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  deleteGitHubToken,
  logGitHubEvent,
  looksLikeGitHubPat,
} from "@/lib/connectors/github";

/**
 * POST /api/github/disconnect (session required)
 * Deletes the vault credential (service "github", label "oauth"). Idempotent.
 * A8: a PAT-shaped body value is refused (403) — disconnect is not a backdoor
 * for manual token entry.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && looksLikeGitHubPat(body.pat ?? body.token)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "PAT_REFUSED",
          message: "PAT refused by A8 — use OAuth.",
        },
      },
      { status: 403 },
    );
  }

  const had = await deleteGitHubToken();
  if (had) await logGitHubEvent("github.disconnected", { via: "panel" });

  return NextResponse.json({ ok: true, connected: false, deleted: had });
}
