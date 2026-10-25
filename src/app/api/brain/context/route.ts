import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasBrainAccess, clampStr } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * GET /api/brain/context?user=<handle>&channel=<channel>&turns=<n>
 *
 * Persistent conversation memory for the brain (v29.8) — survives OBS
 * refreshes, browser restarts, everything: dialogue turns are rebuilt from
 * the InteractionLog itself. Also returns the security lessons so the system
 * prompt can carry the learned caveats. A streamer/mod `!ai reset` moves the
 * memory cutoff forward (Setting key), so logs stay intact for evaluation
 * while the live context starts fresh.
 */
export async function GET(req: Request) {
  if (!rateLimit(`brain-context:${clientKey(req)}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  if (!(await hasBrainAccess(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") || "specimba").toLowerCase().slice(0, 40);
  const user = (url.searchParams.get("user") || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 60);
  const turns = Math.min(10, Math.max(2, Math.round(Number(url.searchParams.get("turns")) || 8)));

  const cutoffKey = `brain.memory.cutoff.${channel}`;
  const cutoffRow = await db.setting.findUnique({ where: { key: cutoffKey } });
  const cutoffAt = cutoffRow ? new Date(cutoffRow.value) : null;
  const cutoffValid = cutoffAt && !Number.isNaN(cutoffAt.getTime()) ? cutoffAt : null;

  const rows = await db.interactionLog.findMany({
    where: {
      channel,
      ...(cutoffValid ? { createdAt: { gt: cutoffValid } } : {}),
      status: { in: ["ok", "refused", "direct"] },
    },
    orderBy: { createdAt: "desc" },
    take: 60,
  });

  // Oldest → newest, then keep only the last `turns` exchanges.
  const ordered = rows.slice().reverse();
  const ladder: Array<{ role: "user" | "assistant"; content: string; name?: string; ts: string }> = [];
  for (const row of ordered) {
    const msg = row.message.trim();
    const reply = row.response.trim();
    if (!msg && !reply) continue;
    const handle = row.displayHandle || row.username;
    if (msg) {
      ladder.push({ role: "user", content: `@${handle}: ${msg.slice(0, 320)}`, name: handle, ts: row.createdAt.toISOString() });
    }
    if (reply) {
      ladder.push({ role: "assistant", content: reply.slice(0, 600), ts: row.createdAt.toISOString() });
    }
  }
  const trimmedLadder = ladder.slice(-turns * 2);

  // The requesting user's own last exchanges lead the ladder when present.
  let userLadder: typeof trimmedLadder = [];
  if (user) {
    const own = await db.interactionLog.findMany({
      where: { channel, username: user, status: { in: ["ok", "refused", "direct"] } },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    const ownOrdered = own.slice().reverse();
    for (const row of ownOrdered) {
      if (row.message.trim()) {
        userLadder.push({ role: "user", content: `@${row.displayHandle || row.username}: ${row.message.slice(0, 320)}`, name: row.displayHandle || row.username, ts: row.createdAt.toISOString() });
      }
      if (row.response.trim()) {
        userLadder.push({ role: "assistant", content: row.response.slice(0, 600), ts: row.createdAt.toISOString() });
      }
    }
    userLadder = userLadder.slice(-6);
  }

  const lessons = await db.securityLesson.findMany({
    orderBy: { lastSeenAt: "desc" },
    take: 12,
  });

  return NextResponse.json({
    ok: true,
    channel,
    cutoff: cutoffValid ? cutoffValid.toISOString() : null,
    turns: trimmedLadder,
    userTurns: userLadder,
    lessons: lessons.map((l) => ({
      technique: l.technique,
      username: l.username,
      hits: l.hits,
      severity: l.severity,
      snippet: clampStr(l.snippet, 90),
      lastSeenAt: l.lastSeenAt.toISOString(),
    })),
  });
}
