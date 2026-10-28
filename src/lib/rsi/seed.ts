import { db } from "@/lib/db";
import { sha256Hex, canonicalJson } from "./hash";
import { CURATION_PAPERS, EVAL_DESIGN, type RsiTaskSeed } from "./types";

/**
 * v35 RSI Lab — idempotent lazy seeding.
 *
 * Content source: src/data/rsi/*.json (static imports of the frozen research
 * artifacts from Tasks 1-a/1-b — the owner's 48-paper corpus and the
 * nexus-rsi-eval-v1 blueprint). Seeding is CHEAP (one count query when rows
 * exist) and runs lazily from the relevant GET routes.
 *
 * FROZEN-SUITE RULE: an existing suite is NEVER overwritten by key. If a
 * suite row already exists, its tasks + configHash stand as frozen v1.0 —
 * tamper-evidence is the AUDIT stage re-checking configHash, not reseeding.
 */

/** Task order for hashing: canonical JSON of the frozen config fields. */
function taskConfigFingerprint(tasks: RsiTaskSeed[]): string {
  return canonicalJson(
    tasks.map((t, idx) => ({
      idx,
      name: t.name,
      prompt: t.prompt,
      verifier: t.verifier,
      verifierConfig: t.verifierConfig,
      difficulty: t.difficulty,
      weight: t.weight,
    })),
  );
}

export function suiteConfigHash(tasks: RsiTaskSeed[]): string {
  return sha256Hex(taskConfigFingerprint(tasks));
}

/** Recompute a stored suite's configHash from live task rows (AUDIT stage). */
export async function recomputeSuiteHash(suiteId: string): Promise<string | null> {
  const tasks = await db.rsiTask.findMany({ where: { suiteId }, orderBy: { idx: "asc" } });
  if (tasks.length === 0) return null;
  return sha256Hex(
    canonicalJson(
      tasks.map((t) => ({
        idx: t.idx,
        name: t.name,
        prompt: t.prompt,
        verifier: t.verifier,
        verifierConfig: t.verifierConfig,
        difficulty: t.difficulty,
        weight: t.weight,
      })),
    ),
  );
}

/** Seed all 48 curated papers if the library is empty. Idempotent. */
export async function ensurePapersSeeded(): Promise<number> {
  const count = await db.rsiPaper.count();
  if (count > 0) return count;
  await db.rsiPaper.createMany({
    data: CURATION_PAPERS.map((p) => ({
      citeKey: p.citeKey,
      title: p.title,
      authorsShort: p.authorsShort,
      year: p.year,
      arxivId: p.arxivId,
      url: p.url,
      category: p.category,
      relevance: p.relevance,
      oneLine: p.oneLine,
      keyTechnique: p.keyTechnique,
      appliesTo: p.appliesTo,
      evidence: p.evidence,
    })),
  });
  return db.rsiPaper.count();
}

/**
 * Seed the 5 frozen suites (23 tasks) from eval-design.json suiteBlueprints
 * if none exist. configHash seals each suite; version 1.0; frozenAt now.
 * Existing suites are NEVER overwritten (tamper-evidence via AUDIT re-hash).
 */
export async function ensureSuitesSeeded(): Promise<number> {
  const count = await db.rsiSuite.count();
  if (count > 0) return count;

  for (const bp of EVAL_DESIGN.suiteBlueprints) {
    const configHash = suiteConfigHash(bp.tasks);
    const suite = await db.rsiSuite.create({
      data: {
        key: bp.key,
        name: bp.name,
        category: bp.category,
        description: bp.description,
        grounding: bp.grounding,
        version: "1.0",
        configHash,
      },
    });
    // Tasks in blueprint order — idx is the frozen execution order.
    let idx = 0;
    for (const t of bp.tasks) {
      await db.rsiTask.create({
        data: {
          suiteId: suite.id,
          idx,
          name: t.name,
          prompt: t.prompt,
          verifier: t.verifier,
          verifierConfig: JSON.stringify(t.verifierConfig ?? {}),
          difficulty: t.difficulty,
          weight: t.weight,
          tags: JSON.stringify(t.tags ?? []),
        },
      });
      idx += 1;
    }
  }
  return db.rsiSuite.count();
}
