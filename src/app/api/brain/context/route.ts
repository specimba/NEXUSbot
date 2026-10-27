import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasBrainAccess, clampStr } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { cortexConvoTurns } from "@/lib/brain/cortex";

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
  // v29.20 — widened shared window: a FLOOR of 10 exchanges even when an
  // older widget generation asks for 8 (rapid-fire senders burned the old
  // 8-row window in ~2-3 minutes → the "iki dk önce söylediğini inkar"
  // class), cap 14.
  const turns = Math.min(14, Math.max(10, Math.round(Number(url.searchParams.get("turns")) || 10)));

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
    const own = rows.filter((r) => String(r.username || "").toLowerCase() === user).slice(0, 12).reverse();
    for (const row of own) {
      if (row.message.trim()) {
        userTurns.push({ role: "user", content: `@${row.displayHandle || row.username}: ${row.message.slice(0, 320)}`, name: row.displayHandle || row.username, ts: row.createdAt.toISOString() });
      }
      if (row.response.trim()) {
        userTurns.push({ role: "assistant", content: row.response.slice(0, 600), ts: row.createdAt.toISOString() });
      }
    }
  }

  // v29.20 — merge the fresh in-memory CONVERSATION RING (written at ANSWER
  // time in /api/brain/cortex — no InteractionLog write race: on a rapid-
  // fire stream the next message arrives before the previous widget log POST
  // lands, so the ring is the only race-free source of the latest turns) with
  // the persisted rows. Ring wins on freshness, DB wins on depth; content-keyed
  // dedup keeps the ladder free of doubles (DB user turns carry the display
  // handle's case, the ring the lowercase sender — keys compare lowercased).
  const ringTurns = cortexConvoTurns(channel, user, turns);
  const seenKeys = new Set<string>();
  const keyOf = (role: string, content: string) => `${role}:${content.slice(0, 100).toLowerCase()}`;
  const merged: Array<{ role: "user" | "assistant"; content: string; ts: number; name?: string }> = [];
  for (const t of userTurns) {
    const k = keyOf(t.role, t.content);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    merged.push({ role: t.role, content: t.content, ts: Date.parse(t.ts), name: t.name });
  }
  for (const t of ringTurns) {
    const k = keyOf(t.role, t.content);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    merged.push({ role: t.role, content: t.content, ts: t.ts });
  }
  merged.sort((a, b) => a.ts - b.ts);
  const trimmedLadder = merged.slice(-turns * 2).map((t) => ({
    role: t.role,
    content: t.content,
    ...(t.name ? { name: t.name } : {}),
    ts: new Date(t.ts).toISOString(),
  }));

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
