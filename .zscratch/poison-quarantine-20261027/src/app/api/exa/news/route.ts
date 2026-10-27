import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ResearchBrief } from "@prisma/client";
import { requireSession } from "@/lib/auth";
import { exaCostTotal, exaSearch, loadExaKey, recordExaUsage } from "@/lib/connectors/exa";

/**
 * GET /api/exa/news?refresh=1 — AI News Radar (v29.13). Session-guarded.
 *
 * Cached ResearchBrief (kind "news") served fresh for 2 hours; refresh=1
 * forces a live Exa /search over the last 36h of AI news (12 results, category
 * "news"). When a refresh fails but a stale brief exists, the stale brief is
 * served with fresh:false + degraded:true (honest degradation, no theatre).
 */

const NEWS_KIND = "news";
const NEWS_QUERY = "artificial intelligence AI agents models major announcements releases news";
const NEWS_TTL_MS = 2 * 60 * 60 * 1000;
const NEWS_WINDOW_MS = 36 * 60 * 60 * 1000;

function clampStr(v: unknown, n: number): string {
  return String(v ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, n);
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function briefPayload(row: ResearchBrief) {
  let items: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(row.items) as unknown;
    if (Array.isArray(parsed)) {
      items = parsed.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object");
    }
  } catch {
    items = [];
  }
  return {
    items,
    formatted: row.formatted,
    provider: "exa",
    tookMs: row.tookMs,
    costDollars: row.costDollars,
    createdAt: row.createdAt.toISOString(),
  };
}

async function latestBrief(): Promise<ResearchBrief | null> {
  return db.researchBrief.findFirst({ where: { kind: NEWS_KIND }, orderBy: { createdAt: "desc" } });
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";

  let cached: ResearchBrief | null = null;
  if (!refresh) {
    cached = await latestBrief();
    if (cached && Date.now() - cached.createdAt.getTime() < NEWS_TTL_MS) {
      return NextResponse.json({ ok: true, fresh: true, brief: briefPayload(cached) });
    }
  }

  const loaded = await loadExaKey();
  if (!loaded.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "EXA_NOT_CONFIGURED",
          message: "Store the Exa API key in Connectors → Exa to arm the news radar.",
        },
      },
      { status: 400 },
    );
  }

  const started = Date.now();
  const r = await exaSearch(loaded.key, {
    query: NEWS_QUERY,
    numResults: 12,
    type: "auto",
    category: "news",
    startPublishedDate: new Date(Date.now() - NEWS_WINDOW_MS).toISOString(),
  });
  const tookMs = Date.now() - started;

  if (!r.ok) {
    recordExaUsage("exa-search", 0, tookMs, false, { radar: "news" });
    if (cached) {
      return NextResponse.json({ ok: true, fresh: false, degraded: true, brief: briefPayload(cached) });
    }
    return NextResponse.json(
      {
        ok: false,
        error: { code: "EXA_NEWS_FAILED", message: `News radar refresh failed: ${clampStr(r.error, 180)}` },
      },
      { status: 502 },
    );
  }

  const cost = exaCostTotal(r.data.costDollars) ?? 0;
  const raw = Array.isArray(r.data.results) ? r.data.results : [];
  const items = raw.map((res) => {
    const contents = (res?.contents ?? {}) as { highlights?: unknown; text?: unknown };
    const highlights = Array.isArray(contents.highlights)
      ? contents.highlights.filter((h): h is string => typeof h === "string")
      : [];
    const text =
      highlights.length > 0
        ? highlights.join(" ")
        : typeof contents.text === "string"
          ? contents.text
          : "";
    const url = typeof res?.url === "string" ? res.url : "";
    return {
      title: clampStr(typeof res?.title === "string" && res.title ? res.title : "(no title)", 140),
      text: clampStr(text, 500),
      url: clampStr(url, 300),
      host: clampStr(hostFromUrl(url), 80),
      date: clampStr(typeof res?.publishedDate === "string" ? res.publishedDate : "", 40),
    };
  });
  const formatted = items
    .map((it, i) => `[${i + 1}|${it.host}] ${it.title} — ${it.text.slice(0, 200)} (${it.url})`)
    .join("\n");

  const row = await db.researchBrief.create({
    data: {
      kind: NEWS_KIND,
      query: NEWS_QUERY,
      formatted: clampStr(formatted, 8000),
      items: JSON.stringify(items).slice(0, 24000),
      tookMs,
      costDollars: cost,
    },
  });

  recordExaUsage("exa-search", cost, tookMs, true, { radar: "news" });
  return NextResponse.json({ ok: true, fresh: false, brief: briefPayload(row) });
}
