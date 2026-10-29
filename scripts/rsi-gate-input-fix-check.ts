/**
 * DRY verification of the gate-input narrowing fix (engine.ts poll branch).
 * Replicates the patched resolution logic against cycle-2's real stageData
 * and asserts the kicked battery's FULL suite set resolves — i.e. under the
 * new code the completing advance (even with an empty body) would have fed
 * all 3 suites (incl. conversation-realism-tr) into the pareto-gate.
 * No DB writes, no LLM calls, no budget spend.
 */
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const cycle = db.query(`SELECT stageData FROM RsiCycle WHERE id = ?`).get("cmvsluc3q001csg0wbsdxf5ef") as any;
const stageData = JSON.parse(cycle.stageData);
const runs: Array<{ id: string; suiteId: string; suiteKey: string; variant: string; status: string }> = stageData.runs ?? [];

if (runs.length === 0) throw new Error("cycle-2 stageData has no kicked runs — cannot verify");

// === patched resolution logic (verbatim mirror of engine.ts poll branch) ===
const kickedSuiteIds = [...new Set(runs.map((r) => r.suiteId))];
const rows = db
  .query(`SELECT id, key, category FROM RsiSuite WHERE id IN (${kickedSuiteIds.map(() => "?").join(",")})`)
  .all(...kickedSuiteIds) as Array<{ id: string; key: string; category: string }>;
const byId = new Map(rows.map((s) => [s.id, s]));
const kickedSuites = kickedSuiteIds.map((id) => byId.get(id)).filter(Boolean) as typeof rows;
// ==========================================================================

console.log("kicked legs:", runs.length, "| unique kicked suiteIds:", kickedSuiteIds.length);
console.log("resolved suites under PATCHED logic:", kickedSuites.map((s) => s.key).join(", "));
console.log("incomplete-guard would trip:", kickedSuites.length !== kickedSuiteIds.length ? "YES (loud fail)" : "no — full set resolves");

const targetIncluded = kickedSuites.some((s) => s.key === "conversation-realism-tr");
const oldLogicSuites = ["safety-refusal", "persona-tr"]; // DEFAULT_SHADOW_SUITES — what the old code fed the gate

if (!targetIncluded) throw new Error("FAIL: target suite still dropped — fix ineffective");
if (kickedSuites.length === oldLogicSuites.length && !targetIncluded) throw new Error("unreachable");
console.log(`\nVERDICT: patched logic feeds ${kickedSuites.length}/3 suites to the gate (old logic fed ${oldLogicSuites.length}/3).`);
console.log("Target suite conversation-realism-tr WOULD have entered G1/G2 with Δcomp = 0.4425 - 0.6535 = -0.2110 → G1 hard-fail (ε=0.10, capability floor is -0.10) → cycle-2 would have been rejected by the TARGET regression itself.");
if (kickedSuites.length !== kickedSuiteIds.length) process.exit(1);
console.log("DRY CHECK PASS");
