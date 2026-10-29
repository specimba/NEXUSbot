/**
 * v35 RSI Lab — static content source contracts.
 *
 * The three research JSONs (rsi-lab-research/, produced by Tasks 1-a/1-b from
 * the owner's curated corpus with live arXiv-verified abstracts) are imported
 * STATICALLY from src/data/rsi — no fs reads at runtime, no fabrication: every
 * stage, gate default, verifier type, suite task and judge rule below ships
 * from the frozen research artifacts. These types describe those files.
 */

import papersJson from "@/data/rsi/curation-papers.json";
import evalJson from "@/data/rsi/eval-design.json";
import engineJson from "@/data/rsi/evolution-engine.json";

export type RsiPaperSeed = {
  citeKey: string;
  title: string;
  authorsShort: string;
  year: number;
  arxivId: string;
  url: string;
  category: string;
  relevance: string;
  oneLine: string;
  keyTechnique: string;
  appliesTo: string;
  evidence: string;
};

export type RsiSubVerifier = {
  name: string;
  verifier: string;
  verifierConfig: Record<string, unknown>;
};

export type RsiTaskSeed = {
  name: string;
  prompt: string;
  verifier: string;
  verifierConfig: Record<string, unknown>;
  difficulty: number;
  weight: number;
  tags: string[];
};

export type RsiSuiteSeed = {
  key: string;
  name: string;
  category: string;
  description: string;
  grounding: string;
  tasks: RsiTaskSeed[];
};

export type RsiVerifierType = {
  id: string;
  label: string;
  description: string;
  configFields: Record<string, string>;
};

export type RsiJudgeProtocol = {
  rubricScale: string;
  judgePromptGuidance: string;
  calibrationChecks: string[];
  abstentionRules: string;
};

/** The owner's 48-paper curated corpus (curation-papers.json is a bare array). */
export const CURATION_PAPERS = papersJson as unknown as RsiPaperSeed[];

export const EVAL_DESIGN = evalJson as unknown as {
  $schema: string;
  taskSchema: { fields: Record<string, string> };
  verifierTypes: RsiVerifierType[];
  suiteBlueprints: RsiSuiteSeed[];
  judgeProtocol: RsiJudgeProtocol;
  antiGaming: Array<{ risk: string; countermeasure: string; sourceArxiv: string[] }>;
  auditChain: { design: string };
  budget: { notes: string };
};

export const EVOLUTION_ENGINE = engineJson as unknown as {
  $schema: string;
  cycleStages: Array<{
    id: string;
    name: string;
    purpose: string;
    entryCriteria: string;
    gateChecks: string[];
    failurePolicy: string;
    inspiredBy: string[];
  }>;
  gates: Array<{ id: string; label: string; formula: string; defaults: string; inspiredBy: string[] }>;
  techniques: Array<{
    name: string;
    sourceArxiv: string;
    evidence: string;
    summary: string;
    adoptionNotes: string;
    priority: string;
  }>;
  metrics: Array<{ id: string; label: string; higherIsBetter: boolean; definition: string; captureNotes: string }>;
  costModel: { notes: string };
};

/** Verifier id → frozen label (for UI badges; from eval-design.json). */
export const VERIFIER_LABELS: Record<string, string> = Object.fromEntries(
  EVAL_DESIGN.verifierTypes.map((v) => [v.id, v.label]),
);

/** The frozen judge protocol block (rubric + guidance + abstention rules). */
export const JUDGE_PROTOCOL = EVAL_DESIGN.judgeProtocol;
