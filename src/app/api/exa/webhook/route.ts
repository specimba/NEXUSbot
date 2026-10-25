import { NextResponse } from "next/server";
import { pushWebhookItem } from "@/lib/connectors/exa";
import { db } from "@/lib/db";
import { clampStr } from "@/lib/brain/auth";

/**
 * POST /api/exa/webhook — receiver for Exa Monitor pushes (v29.12).
 *
 * Exa Monitors fire on their interval and POST deduped results here. The
 * endpoint is public by necessity (Exa's servers must reach it), so it is
 * hardened instead of session-gated:
 *   - 64 KB body cap, 30/min IP rate limit
 *   - payload shape validation (expects {monitor/run/data...} Envelope; any
 *     well-formed JSON is archived but flagged kind "unknown")
 *   - stored in the exa.webhook.inbox Setting (last 30) for the panel card
 *   - secrets are never echoed back; response is a bare 200 (no reflection)
 *
 * GET returns 405 intentionally — nothing about this surface is browseable.
 */
export async function POST(req: Request) {
  const ip =
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!rateLimitWebhook(ip)) {
    return new Response(null, { status: 429 });
  }
  const raw = await req.text();
  if (raw.length > 64_000) return new Response(null, { status: 413 });

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object") {
    return new Response(null, { status: 400 });
  }

  const monitorId = clampStr(
    (parsed.monitorId as string) ?? (parsed.monitor_id as string) ?? (parsed.id as string) ?? "",
    80,
  );
  const eventType = clampStr((parsed.event as string) ?? (parsed.type as string) ?? "monitor.result", 40);

  await pushWebhookItem({
    receivedAt: new Date().toISOString(),
    monitorId: monitorId || "unknown",
    kind: eventType,
    payload: parsed,
  });

  // Marker row so the Pipeline tab can show "last webhook at" without parsing.
  await db.setting
    .upsert({
      where: { key: "exa.webhook.last" },
      create: { key: "exa.webhook.last", value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "POST only" }, { status: 405 });
}

// Small local limiter (the shared guard limiter is fine too, but webhooks need
// a separate namespace so bursts from Exa never collide with panel traffic).
const hits = new Map<string, { count: number; reset: number }>();
function rateLimitWebhook(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now > h.reset) {
    hits.set(key, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (h.count >= 30) return false;
  h.count += 1;
  return true;
}
