import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { redactSecrets } from "@/lib/brain/auth";
import { normalizeTr } from "@/lib/brain/normalize-tr";

/**
 * NEXUS OS v37 — Lore Book (Phase G3, plan §5).
 *
 * The measured D4 failure: the channel's inside joke ("DJ Nikolina") went
 * to Exa research twice and came back as pipe-smoking guides; the owner:
 * "şu toollarını düzgünce kullan". Community jokes are CHANNEL FACTS — they
 * live in a panel-owned store, not on the web.
 *
 * Storage: Setting KV key `brain.lore` (JSON array) — chosen deliberately:
 * the seal collects ALL Setting rows generically, so lore survives
 * cold-boot restore via the encrypted seal with ZERO seal/schema work
 * (plan §1, seal.ts generic collector). No new Prisma model.
 *
 * Matching: normalizeTr (Turkish-correct fold, diacritic-insensitive) on
 * BOTH aliases and prompt, plain substring containment (JS \b is ASCII-only —
 * house note, cortex.ts:446). Rank by alias length desc; inject top-3 only.
 *
 * ROUTING (plan critique #1): a lore hit does NOT blindly short-circuit
 * research — only entries flagged `blockResearch` (pure in-jokes) flip
 * RESEARCH→CHAT. "DJ Nikolina'nın yeni albümü çıktı mı?" can still go to
 * research WITH the lore card attached for context.
 *
 * Trust model: owner-authored (trusted), capped (40 × 400 chars), wrapped
 * as quoted data in the prompt, redactSecrets-scrubbed at write. Worst case
 * is bounded prompt noise, never viewer injection.
 */

export const LORE_KEY = "brain.lore";
const LORE_MAX_ENTRIES = 40;
const LORE_MAX_TEXT = 400;
const LORE_MAX_ALIASES = 6;
const LORE_ALIAS_MIN = 3;
const LORE_ALIAS_MAX = 24;

export type LoreEntry = {
  id: string;
  aliases: string[];
  text: string;
  blockResearch?: boolean;
  createdAt: number;
  updatedAt: number;
};

type LoreCache = { entries: LoreEntry[] | null; at: number };

const g = globalThis as typeof globalThis & { __nexusLoreCache?: LoreCache };
const cache: LoreCache = g.__nexusLoreCache ?? (g.__nexusLoreCache = { entries: null, at: 0 });

const LORE_TTL_MS = 60_000;

function invalidateLoreCache(): void {
  cache.entries = null;
  cache.at = 0;
  // Cross-module freshness: an owner edit must reach the RESEARCH flip on
  // the very next message — zero the grounding warmer's TTL guard too,
  // otherwise a ≤60s window serves the old lore state.
  const g = globalThis as typeof globalThis & { __nexusGrounding?: { freshAt: number } };
  if (g.__nexusGrounding) g.__nexusGrounding.freshAt = 0;
}

/** Cached list read (60s TTL, hot path-safe). */
export async function listLore(): Promise<LoreEntry[]> {
  if (cache.entries) return cache.entries;
  try {
    const row = await db.setting.findUnique({ where: { key: LORE_KEY } });
    const parsed = row ? (JSON.parse(row.value) as LoreEntry[]) : [];
    cache.entries = Array.isArray(parsed)
      ? parsed
          .filter((e) => e && typeof e.id === "string" && Array.isArray(e.aliases) && typeof e.text === "string")
          .slice(0, LORE_MAX_ENTRIES)
      : [];
  } catch {
    cache.entries = [];
  }
  cache.at = Date.now();
  return cache.entries!;
}

export async function countLore(): Promise<number> {
  return (await listLore()).length;
}

function validateAliases(raw: unknown): { ok: true; aliases: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "At least one alias is required." };
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const item of raw) {
    const alias = String(item ?? "").trim();
    if (alias.length < LORE_ALIAS_MIN || alias.length > LORE_ALIAS_MAX) {
      return { ok: false, error: `Alias "${alias.slice(0, 16)}" must be ${LORE_ALIAS_MIN}-${LORE_ALIAS_MAX} chars.` };
    }
    const key = normalizeTr(alias);
    if (!key) return { ok: false, error: `Alias "${alias.slice(0, 16)}" has no matchable letters.` };
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= LORE_MAX_ALIASES) break;
  }
  if (!aliases.length) return { ok: false, error: "At least one valid alias is required." };
  return { ok: true, aliases };
}

export type LoreUpsertInput = { id?: string; aliases: unknown; text: unknown; blockResearch?: unknown };

/** Create or update (id present → update). Returns the stored entry. */
export async function upsertLore(input: LoreUpsertInput): Promise<{ ok: true; entry: LoreEntry } | { ok: false; error: string }> {
  const aliasCheck = validateAliases(input.aliases);
  if (!aliasCheck.ok) return { ok: false, error: aliasCheck.error };
  const text = redactSecrets(String(input.text ?? "").trim().slice(0, LORE_MAX_TEXT));
  if (text.length < 3) return { ok: false, error: "Lore text is required (3-400 chars)." };
  const blockResearch = input.blockResearch === true;

  const entries = await listLore();
  const now = Date.now();
  let entry: LoreEntry;
  if (input.id) {
    const idx = entries.findIndex((e) => e.id === input.id);
    if (idx === -1) return { ok: false, error: "Lore entry not found." };
    entry = {
      ...entries[idx],
      aliases: aliasCheck.aliases,
      text,
      blockResearch,
      updatedAt: now,
    };
    entries[idx] = entry;
  } else {
    if (entries.length >= LORE_MAX_ENTRIES) {
      return { ok: false, error: `Lore Book is full (${LORE_MAX_ENTRIES}). Delete one first.` };
    }
    entry = {
      id: createHash("sha256").update(`${now}:${aliasCheck.aliases.join("|")}`).digest("hex").slice(0, 12),
      aliases: aliasCheck.aliases,
      text,
      blockResearch,
      createdAt: now,
      updatedAt: now,
    };
    entries.unshift(entry);
  }
  await db.setting.upsert({
    where: { key: LORE_KEY },
    create: { key: LORE_KEY, value: JSON.stringify(entries) },
    update: { value: JSON.stringify(entries) },
  });
  invalidateLoreCache();
  return { ok: true, entry };
}

export async function deleteLore(id: string): Promise<boolean> {
  const entries = await listLore();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  await db.setting.upsert({
    where: { key: LORE_KEY },
    create: { key: LORE_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  invalidateLoreCache();
  return true;
}

export async function deleteAllLore(): Promise<number> {
  const entries = await listLore();
  if (!entries.length) return 0;
  await db.setting.upsert({
    where: { key: LORE_KEY },
    create: { key: LORE_KEY, value: JSON.stringify([]) },
    update: { value: JSON.stringify([]) },
  });
  invalidateLoreCache();
  return entries.length;
}

// ---------------------------------------------------------------------------
// Matching (hot-path safe: sync, cached list, normalized containment)
// ---------------------------------------------------------------------------

export type LoreMatch = { entry: LoreEntry; matchedAlias: string };

/**
 * Prompt↔lore alias matching. Uses the CACHED list (the grounding compiler
 * refreshes it fire-and-forget); returns matches ranked longest-alias-first,
 * capped at 3 (plan §5 injection guard).
 */
export function matchLoreCached(prompt: string): LoreMatch[] {
  const entries = cache.entries;
  if (!entries || !entries.length) return [];
  const normalized = normalizeTr(prompt);
  if (!normalized) return [];
  const hits: Array<{ entry: LoreEntry; matchedAlias: string; normAlias: string }> = [];
  for (const entry of entries) {
    let best: { alias: string; norm: string } | null = null;
    for (const alias of entry.aliases) {
      const norm = normalizeTr(alias);
      if (norm && normalized.includes(norm)) {
        if (!best || norm.length > best.norm.length) best = { alias, norm };
      }
    }
    if (best) hits.push({ entry, matchedAlias: best.alias, normAlias: best.norm });
  }
  hits.sort((a, b) => b.normAlias.length - a.normAlias.length);
  return hits.slice(0, 3).map((h) => ({ entry: h.entry, matchedAlias: h.matchedAlias }));
}

/**
 * Research flip (plan critique #1): true when a matched entry is flagged
 * blockResearch — ONLY then does the RESEARCH route demote to CHAT.
 * Un-flagged entities keep their research path with the lore card attached.
 * Reads the cache; when cold, returns false (research keeps its lane).
 */
export function loreBlocksResearchCached(prompt: string): boolean {
  return matchLoreCached(prompt).some((m) => m.entry.blockResearch === true);
}

/**
 * Async wrapper — the authoritative path for the cortex RESEARCH flip: one
 * cached listLore() read (≤1 DB hit/60s, research prompts only — never the
 * chat hot path), so an owner edit is visible on the very next message
 * even when the sync cache was cold.
 */
export async function loreBlocksResearch(prompt: string): Promise<boolean> {
  try {
    await listLore();
  } catch {
    return false; // store unavailable — research keeps its lane
  }
  return loreBlocksResearchCached(prompt);
}

/** Async wrapper for route-level freshness: refresh cache then match. */
export async function matchLore(prompt: string): Promise<LoreMatch[]> {
  await listLore();
  return matchLoreCached(prompt);
}
