import { db } from "@/lib/db";
import { exaSearch } from "@/lib/connectors/exa";
import { runWebSearch } from "@/lib/brain/search";
import { clampStr } from "@/lib/brain/auth";

/**
 * NEXUS OS — Exa daily AI-news digest (v29.12).
 *
 * The stream's most-asked research question is "bugün yapay zekada ne var?" —
 * previously answered from stale LLM priors or generic ddg snippets (the
 * hallucination class the owner complained about). Now:
 *
 *   1. Exa search (auto, last 2 days, highlights + one-line summaries)
 *   2. z-ai fallback when Exa is unconfigured/budget-exhausted (still real
 *      search, weaker grounding — labeled honestly)
 *
 * Cache: Setting "exa.news.digest", TTL 30 min, with a URL-based dedup ledger
 * so consecutive digests show only NEW items first (Exa-Monitor spirit, done
 * locally with zero extra spend). The edge brain can pull this digest for
 * free when a viewer asks for today's news — no search spend per message.
 */

export const EXA_DIGEST_SETTING = "exa.news.digest";
export const DIGEST_TTL_MS = 30 * 60_000;
/** General (Türkiye) news pool — "haberleri derle" must NEVER be answered from
 *  model priors (owner complaint 02:31 +03: hallucinated headlines like
 *  "Merkel'in Sakıp Çalışkan Kitabı"). Deterministic compile from real
 *  search results, cached so chat spam can't burn the budget. */
export const GENERAL_DIGEST_SETTING = "exa.news.general";
export const GENERAL_TTL_MS = 15 * 60_000;

export type DigestItem = {
  title: string;
  url: string;
  summary: string;
  date: string;
  source: string;
};

export type NewsDigest = {
  ok: boolean;
  provider: "exa" | "z-ai" | "cache" | "";
  builtAt: string;
  items: DigestItem[];
  freshCount: number;
  error: string;
};

type StoredDigest = NewsDigest & { seenUrls: string[] };

const DIGEST_QUERY =
  "latest artificial intelligence news today: OpenAI, Anthropic, Google DeepMind, Meta AI, open-source LLM releases, AI agents";
const GENERAL_QUERY = "Türkiye bugün son dakika haberleri gündem özeti";
const GENERAL_FALLBACK_QUERY = "son dakika haberleri Türkiye bugün gündem";

function digestHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function readStored(settingKey: string): Promise<StoredDigest | null> {
  const row = await db.setting.findUnique({ where: { key: settingKey } }).catch(() => null);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as StoredDigest;
  } catch {
    return null;
  }
}

async function writeStored(settingKey: string, d: StoredDigest): Promise<void> {
  await db.setting
    .upsert({
      where: { key: settingKey },
      create: { key: settingKey, value: JSON.stringify(d) },
      update: { value: JSON.stringify(d) },
    })
    .catch(() => {});
}

/**
 * Build (or serve cached) the digest. `force` bypasses the TTL but still
 * merges the seen-URL ledger so fresh items are ordered first.
 *
 * v29.14: generic core — the AI digest and the general (Türkiye) digest share
 * the cache/dedup/fallback machinery; only query + TTL differ.
 */
async function buildDigest(
  opts: {
    settingKey: string;
    ttlMs: number;
    query: string;
    fallbackQuery: string;
    numResults: number;
    recencyDays: number;
    force: boolean;
  },
): Promise<NewsDigest> {
  const { settingKey, ttlMs, query, fallbackQuery, numResults, recencyDays, force } = opts;
  const stored = await readStored(settingKey);
  const fresh = stored ? Date.now() - Date.parse(stored.builtAt || "") < ttlMs : false;
  if (!force && stored && fresh && stored.ok) {
    return {
      ok: true,
      provider: "cache",
      builtAt: stored.builtAt,
      items: stored.items,
      freshCount: stored.freshCount,
      error: "",
    };
  }

  const seenUrls = new Set(stored?.seenUrls ?? []);
  let items: DigestItem[] = [];
  let provider: NewsDigest["provider"] = "";
  let error = "";

  // 1) Exa-first (aggressive-by-design; budgets gate this internally).
  const exa = await exaSearch({ query, numResults, recencyDays, type: "auto" });
  if (exa.ok) {
    provider = "exa";
    items = exa.results.map((r) => ({
      title: r.title,
      url: r.url,
      summary: r.summary || r.highlight,
      date: r.publishedDate ? r.publishedDate.slice(0, 10) : "",
      source: digestHost(r.url),
    }));
  } else {
    error = exa.error;
  }

  // 2) z-ai fallback — never leave the digest empty while a key is missing.
  if (!items.length) {
    const fb = await runWebSearch(fallbackQuery, { num: 6, recencyDays });
    if (fb.ok) {
      provider = "z-ai";
      items = fb.snippets.map((s) => ({
        title: s.title,
        url: s.url,
        summary: s.text,
        date: s.date,
        source: s.host || digestHost(s.url),
      }));
      error = "";
    } else {
      // Both tiers failed — surface BOTH causes honestly (the panel card and
      // the edge diagnostics both render this string).
      error = [error ? "exa: " + error : "", fb.error ? "fallback: " + fb.error : ""]
        .filter(Boolean)
        .join(" | ");
    }
  }

  const newFirst = [...items].sort(
    (a, b) => Number(seenUrls.has(b.url)) - Number(seenUrls.has(a.url)),
  );
  const freshCount = items.filter((i) => i.url && !seenUrls.has(i.url)).length;

  const digest: StoredDigest = {
    ok: items.length > 0,
    provider,
    builtAt: new Date().toISOString(),
    items: newFirst,
    freshCount,
    error,
    seenUrls: Array.from(new Set([...seenUrls, ...items.map((i) => i.url).filter(Boolean)])).slice(-200),
  };
  await writeStored(settingKey, digest);
  return digest;
}

export async function buildNewsDigest(force = false): Promise<NewsDigest> {
  return buildDigest({
    settingKey: EXA_DIGEST_SETTING,
    ttlMs: DIGEST_TTL_MS,
    query: DIGEST_QUERY,
    fallbackQuery: "bugün yapay zeka haberleri AI news today",
    numResults: 8,
    recencyDays: 2,
    force,
  });
}

/** General Türkiye headlines — the "haberleri derle / günün haberleri"
 *  answer pool (15-min cache, same dedup ledger discipline). */
export async function buildGeneralDigest(force = false): Promise<NewsDigest> {
  return buildDigest({
    settingKey: GENERAL_DIGEST_SETTING,
    ttlMs: GENERAL_TTL_MS,
    query: GENERAL_QUERY,
    fallbackQuery: GENERAL_FALLBACK_QUERY,
    numResults: 6,
    recencyDays: 1,
    force,
  });
}

/** Compact text form for the edge brain / VYCE context injection. */
export async function digestAsContext(maxChars = 1600): Promise<string> {
  const d = await buildNewsDigest(false);
  if (!d.ok || !d.items.length) return "";
  const lines = d.items
    .slice(0, 8)
    .map(
      (i, idx) =>
        `${idx + 1}. ${i.title}${i.date ? " (" + i.date + ")" : ""} — ${clampStr(i.summary, 160)} [${i.source}]`,
    );
  const text = "Bugünün AI gündemi (kaynaklı):\n" + lines.join("\n");
  return text.slice(0, maxChars);
}
