import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { ensureMirrorProbe, probeMirror, readMirrorStatus } from "@/lib/brain/mirror";

/**
 * GET /api/connectors/supabase/mirror — the mirror status in EXACTLY the shape
 * the Pipeline tab consumes (same Setting("brain.mirror.status") source of
 * truth as /api/interactions). Kicks a throttled background probe so a stale
 * boot state self-corrects. E1: makes Connectors → Supabase and the Pipeline
 * tab agree instead of "CONNECTED here, OFFLINE there".
 *
 * POST /api/connectors/supabase/mirror — force a fresh probe NOW (awaits the
 * RPC no-op + the pooler SQL diagnostic) and return the updated status. Used
 * by the Supabase card's "Test mirror" button.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  void ensureMirrorProbe();
  const mirror = await readMirrorStatus();
  return NextResponse.json({ ok: true, mirror });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`supabase-mirror-probe:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }

  const mirror = await probeMirror();
  return NextResponse.json({ ok: true, mirror });
}
