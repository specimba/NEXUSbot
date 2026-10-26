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
 *
 * v29.14 — the ladder is USER-SCOPED. The old channel-wide ladder served the
 * most-active viewer's turns to EVERYONE (measured 02:31 +03: @Robotic_Darkelf_Jedi
 * asked "benim hakkimda bilgi ver" and the model answered him as
 * "@yavuzerdem99" — cross-viewer identity confusion, plus internal lesson
 * strings like "MİMAR KİMLİK KİLİDİ" got echoed verbatim). Room context
 * still reaches the brain through the widget's separate roomTranscript
 * field, so nothing is lost. Own-turn matching is case-insensitive in JS
 * (SQLite `=` is case-sensitive and Kick handles carry mixed case).
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
    take: 200,
  });

  // Oldest → newest. The ladder now serves ONLY the requesting user's own
  // exchanges (v29.14 fix); a viewer with no history gets an empty ladder and
  // the widget falls back to its own sender-scoped local dossier — a fresh
  // viewer is never mistaken for the channel's loudest voice again.
  const userTurns: Array<{ role: "user" | "assistant"; content: string; name?: string; ts: string }> = [];
  if (user) {
    const own = rows.filter((r) => String(r.username || "").toLowerCase() === user).slice(0, 8).reverse();
    for (const row of own) {
      if (row.message.trim()) {
        userTurns.push({ role: "user", content: `@${row.displayHandle || row.username}: ${row.message.slice(0, 320)}`, name: row.displayHandle || row.username, ts: row.createdAt.toISOString() });
      }
      if (row.response.trim()) {
        userTurns.push({ role: "assistant", content: row.response.slice(0, 600), ts: row.createdAt.toISOString() });
      }
    }
  }
  const trimmedLadder = userTurns.slice(-turns * 2);

  const lessons = await db.securityLesson.findMany({
    orderBy: { lastSeenAt: "desc" },
    take: 12,
  });

  return NextResponse.json({
    ok: true,
    channel,
    cutoff: cutoffValid ? cutoffValid.toISOString() : null,
    turns: trimmedLadder,
    userTurns: trimmedLadder,
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
