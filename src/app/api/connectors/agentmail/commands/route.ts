import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadAgentMailKey, pollAgentMailCommands } from "@/lib/connectors/agentmail";

/**
 * v37.3 — mail→bot command lane, PULL-BASED poll (the webhook stays parked,
 * §7.2). Session-guarded for the panel button; the mail-cadence service runs
 * the same lib function directly via scripts/mail-cadence.ts.
 *
 * POST body {}          → poll + execute + reply (triple-gated: owner
 *                         allowlist · Agent Armor verdict "clear" · strict
 *                         subject whitelist — help/status/digest/ping/uptime).
 * POST body {dryRun:true} → poll WITHOUT executing or replying; reports what
 *                         WOULD run (the cursor is not advanced either).
 */
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };

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

  const poll = await pollAgentMailCommands(loaded.key, { dryRun: body.dryRun === true });
  if (!poll.ok) {
    return NextResponse.json({ ok: false, error: poll.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...poll.data });
}
