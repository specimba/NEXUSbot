import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clampStr } from "@/lib/brain/auth";

/**
 * GET /api/interactions?filter=all|flagged|errors&limit=<n> — Pipeline tab feed.
 *
 * Panel-session only. Returns recent InteractionLog rows, aggregate stats for
 * the last 500 interactions (model mix, provider mix, flag mix, web usage,
 * p50/p95 latency) and the security lessons list.
 */
export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const url = new URL(req.url);
  const filter = (url.searchParams.get("filter") || "all").toLowerCase();
  const limit = Math.min(150, Math.max(5, Math.round(Number(url.searchParams.get("limit")) || 60)));

  const where =
    filter === "flagged"
      ? { injectionScore: { gt: 0 } }
      : filter === "errors"
        ? { status: { in: ["error", "timeout", "busy"] } }
        : {};

  const [rows, recent, lessons] = await Promise.all([
    db.interactionLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
    db.interactionLog.findMany({ orderBy: { createdAt: "desc" }, take: 500, select: { model: true, provider: true, route: true, status: true, flags: true, injectionScore: true, webUsed: true, memoryUsed: true, latencyMs: true, command: true } }),
    db.securityLesson.findMany({ orderBy: { lastSeenAt: "desc" }, take: 24 }),
  ]);

  const tally = (pick: (r: (typeof recent)[number]) => string) => {
    const map = new Map<string, number>();
    for (const r of recent) {
      const key = pick(r) || "—";
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  };

  const latencies = recent
    .map((r) => r.latencyMs)
    .filter((n): n is number => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  const p = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null);

  const flagCounts = new Map<string, number>();
  for (const r of recent) {
    try {
      const flags = JSON.parse(r.flags) as string[];
      for (const f of flags) flagCounts.set(f, (flagCounts.get(f) || 0) + 1);
    } catch {}
  }

  return NextResponse.json({
    ok: true,
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      username: r.displayHandle || r.username,
      command: r.command,
      message: r.message,
      response: r.response,
      model: r.model,
      modelId: r.modelId,
      provider: r.provider,
      route: r.route,
      status: r.status,
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      webUsed: r.webUsed,
      memoryUsed: r.memoryUsed,
      flags: (() => {
        try {
          return JSON.parse(r.flags) as string[];
        } catch {
          return [] as string[];
        }
      })(),
      injectionScore: r.injectionScore,
      error: r.error,
    })),
    stats: {
      total: recent.length,
      byModel: tally((r) => r.model),
      byProvider: tally((r) => r.provider),
      byCommand: tally((r) => r.command),
      byStatus: tally((r) => r.status),
      flaggedCount: recent.filter((r) => r.injectionScore > 0).length,
      webUsedCount: recent.filter((r) => r.webUsed).length,
      memoryUsedCount: recent.filter((r) => r.memoryUsed).length,
      latencyP50: p(0.5),
      latencyP95: p(0.95),
      flagCounts: Array.from(flagCounts.entries()).sort((a, b) => b[1] - a[1]),
    },
    lessons: lessons.map((l) => ({
      id: l.id,
      technique: l.technique,
      username: l.username,
      snippet: clampStr(l.snippet, 120),
      counter: l.counter,
      hits: l.hits,
      severity: l.severity,
      lastSeenAt: l.lastSeenAt.toISOString(),
    })),
  });
}
