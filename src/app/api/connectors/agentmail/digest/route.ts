import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  loadAgentMailKey,
  buildAgentMailDigest,
  sendDailyDigest,
  istanbulDay,
  AGENTMAIL_OWNER_EMAIL,
} from "@/lib/connectors/agentmail";

/**
 * v37.3 — daily digest (docs/agentmail-deep-dive.md §7.3).
 *
 * POST body {}             → build yesterday's (Istanbul) digest and SEND it
 *                             to the owner via the send lane. Costs one of the
 *                             100/day free-tier sends.
 * POST body {preview:true} → build WITHOUT sending (panel preview / test).
 *
 * The daily 06:00 Istanbul cron lives in scripts/mail-cadence.ts (spawned by
 * the mail-cadence mini-service) — dedupe state is written THERE, not here:
 * a panel send never claims the day's auto-digest.
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { preview?: boolean };
  const preview = body.preview === true;

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

  if (preview) {
    const digest = await buildAgentMailDigest(istanbulDay(Date.now() - 24 * 60 * 60 * 1000));
    return NextResponse.json({ ok: true, preview: true, digest });
  }

  const sent = await sendDailyDigest(loaded.key);
  if (!sent.ok) {
    return NextResponse.json({ ok: false, error: sent.error }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    preview: false,
    to: AGENTMAIL_OWNER_EMAIL,
    digest: sent.data.digest,
    sent: sent.data.sent,
  });
}
