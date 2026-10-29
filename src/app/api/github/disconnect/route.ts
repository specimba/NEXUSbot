import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  deleteGitHubToken,
  logGitHubEvent,
  looksLikeGitHubPat,
} from "@/lib/connectors/github";

/**
 * POST /api/github/disconnect (session required)
 * Deletes the vault credential (service "github", label "user-token" — plus any
 * pre-12-b "oauth" row). Idempotent. The ops/vault/github.token mirror is
 * intentionally LEFT IN PLACE: it is the independent durability credential used
 * by scripts/snapshot-backup.sh (askpass), and removing it here would silently
 * break the 6h backup cadence. Remove it manually if revocation is intended.
 * A8: a PAT-shaped body value is refused (403) — disconnect is not a backdoor
 * for manual token entry.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  if (!rateLimit(`github-disconnect:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — retry in a minute." } },
      { status: 429 },
    );
  }

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
