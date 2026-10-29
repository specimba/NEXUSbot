import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  loadAgentMailKey,
  probeAgentMail,
  type AgentMailStatusPayload,
} from "@/lib/connectors/agentmail";

/**
 * v37.1 — AgentMail connector status. Session-guarded.
 *
 * One sweep: auth/me (key + scope) → inboxes (org + our inbox) → labs
 * (Agent Armor state; POST is idempotent [MEASURED]). Honest three-state
 * reporting: configured / reachable / apiOk — a reachable host with a
 * rejected key is NOT "connected" (zero theatre).
 */
function respond(status: AgentMailStatusPayload) {
  return NextResponse.json({ ok: true, status });
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const loaded = await loadAgentMailKey();

  if (!loaded.ok && loaded.reason === "missing") {
    return respond({
      configured: false,
      reachable: null,
      apiOk: null,
      error: null,
      credential: null,
      probedAt: null,
      inbox: null,
      labsEnabled: null,
    });
  }
  if (!loaded.ok) {
    return respond({
      configured: true,
      reachable: null,
      apiOk: null,
      error: "Stored AgentMail key is unreadable (vault key rotated out?) — re-save the key.",
      credential: null,
      probedAt: null,
      inbox: null,
      labsEnabled: null,
    });
  }

  const probe = await probeAgentMail(loaded.key);
  return respond({
    configured: true,
    ...probe,
    credential: { masked: loaded.masked, keyId: loaded.keyId, updatedAt: loaded.updatedAt },
  });
}
