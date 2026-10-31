// v387-20261031-defect-probe — READONLY, zero live sends, zero model spend.
// Exercises the REAL exported helpers from src/lib/brain/cortex.ts:
//   residueNamesTopic (v38.7 topic-bearing gating — the measured erlik/polonya
//   query-pollution class), terminalSynthDeadline (the terminal-synthesis
//   floor), plus classifyIntent/researchResidue regression locks from v38/v38.5
// (the concurrent cron-20261031-0425 cycle's probe stays untouched — this file
// covers the classes it deferred: query pollution + ladder starvation).
import {
  classifyIntent,
  residueNamesTopic,
  terminalSynthDeadline,
  researchResidue,
} from "../src/lib/brain/cortex";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
}

// --- A) TOPIC-BEARING short questions must NOT be enriched (v38.7) ---
// The measured 03:47-03:5x +03 rows: "erlik kimdir" got "tekmil ver" |
// "kimsin nerdensin" welded into the Exa query → the gate dropped a PERFECT
// answer (Event 00:47:47Z) → 17s static; "polonyada neler oluyor" imported
// the China space-plane entities into the Poland answer.
const topicCases: Array<[string, string, boolean]> = [
  ["measured-erlik", "erlik kimdir", true],
  ["measured-polonya", "polonyada neler oluyor", true],
  ["measured-gorsel", "gorselin linkini ver", true],
  ["measured-polonya-hakkinda", "polonya hakkinda az once bise olmus onu soruyorum", true],
  ["entity-english", "china mysterious space plane pentagon images nedir", true],
  ["number-topic", "2026 da turkiyede ne oldu", true],
];
for (const [label, prompt, want] of topicCases) {
  const got = residueNamesTopic(prompt);
  check(`topic-gate ${label}`, got === want, `residueNamesTopic=${got} want=${want}`);
}

// --- B) TRUE FRAGMENTS keep the antecedent enrichment (v29.22 regression) ---
const fragmentCases: Array<[string, string]> = [
  ["v2922-yonetmeni", "yönetmeni kim"],
  ["v2922-yonetmeni-ascii", "yonetmeni kim"],
  ["v2922-hakkinda", "hakkinda detayli bilgi ver"],
  ["v2922-sarkisi", "sarkisi kac sanedir"],
  ["v2922-filmi-yonetti", "filmi kim yonetti"],
  ["v2922-oyuncusu", "oyuncusu kimdir"],
];for (const [label, prompt] of fragmentCases) {
  const got = residueNamesTopic(prompt);
  check(`fragment-keep ${label}`, got === false, `residueNamesTopic=${got} want=false`);
}

// --- C) Imperative-only path precedence is intact (v38.5 lock + v38.7 gate) ---
// No-topic commands must name no topic of their own — the query comes from
// the ladder (v38.7 replaced the <8-char threshold with this same signal
// after the probe caught "olum sen salakmısın…" failing the char gate).
check(
  "imperative-haber-no-topic",
  residueNamesTopic("haber sitelerine bak acil") === false,
  `residue="${researchResidue("haber sitelerine bak acil")}"`,
);
check(
  "imperative-exa-deep-no-topic",
  residueNamesTopic("olum sen salakmısın exa ile deep search yapsana mal") === false,
  `residue="${researchResidue("olum sen salakmısın exa ile deep search yapsana mal")}"`,
);
check(
  "imperative-bilmiyosan-no-topic",
  residueNamesTopic("lan bilmiyosan bak amk") === false,
  `residue="${researchResidue("lan bilmiyosan bak amk")}"`,
);
// A command that NAMES its topic must NOT be imperative-only (bare query is
// correct — the topic is IN the message).
check(
  "imperative-topic-command-stays-bare",
  residueNamesTopic("polonyayı ara") === true,
  `residue="${researchResidue("polonyayı ara")}"`,
);

// --- D) Terminal-synthesis floor math (v38.7 — pure floor, no cap) ---
{
  const now = Date.now();
  const starved = terminalSynthDeadline(now + 500); // budget nearly exhausted
  check("floor-starved-fresh", starved >= now + 8_800 && starved <= now + 9_600, `starved=${starved - now}ms`);
  const mid = terminalSynthDeadline(now + 5_000); // 5s left → fresh 9s wins
  check("floor-mid-fresh", mid >= now + 8_800 && mid <= now + 9_600, `mid=${mid - now}ms`);
  const far = terminalSynthDeadline(now + 15_000); // deadline dominates
  check("floor-far-unchanged", Math.abs(far - (now + 15_000)) < 50, `far=${far - now}ms`);
  const past = terminalSynthDeadline(now - 3_000); // deadline ALREADY passed
  check("floor-past-still-fresh", past >= now + 8_800 && past <= now + 9_600, `past=${past - now}ms`);
}

// --- E) classifyIntent regression locks (v38/v38.5 corpus, unchanged code) ---
const researchMust: string[] = [
  "polonyada neler oluyor",
  "haber sitelerine bak acil",
  "olum sen salakmısın exa ile deep search yapsana mal",
  "lan exa ile arasana",
  "güncel durum ne türkiyede",
];
for (const p of researchMust) {
  check(`classify-research ${p.slice(0, 28)}`, classifyIntent(p) === "RESEARCH", `got=${classifyIntent(p)}`);
}
const chatMust: string[] = [
  "ne oluyo kanka",
  "naber",
  "kitap oku da dinleyelim",
];
for (const p of chatMust) {
  check(`classify-chat ${p.slice(0, 28)}`, classifyIntent(p) === "CHAT", `got=${classifyIntent(p)}`);
}
// "araba çiz bana" is a DRAW command — the designed routing (locked since
// v38: draw shapes never leak into research).
check("classify-draw araba çiz bana", classifyIntent("araba çiz bana") === "DRAW", `got=${classifyIntent("araba çiz bana")}`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
