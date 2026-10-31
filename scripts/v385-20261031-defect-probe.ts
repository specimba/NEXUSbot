// v385-20261031-defect-probe — READONLY, zero live sends, zero model spend.
// Exercises the REAL exported helpers from src/lib/brain/cortex.ts (not a
// regex replica): classifyIntent, parseAraSentinel, researchResidue,
// buildSystemPrompt. Covers the owner-flagged 2026-10-31 02:15-02:23 +03
// "nonsense dumbness" rows (three CHAT-lane refusals while the grounded Exa
// lane sat armed one route away) plus the locked v38 regression corpus.
import {
  classifyIntent,
  parseAraSentinel,
  researchResidue,
  buildSystemPrompt,
} from "../src/lib/brain/cortex";
import { exaAnswerIsRelevant, researchQueryTokens } from "../src/lib/brain/grounding";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
}

// --- A) Classifier: tonight's measured misses must now route to RESEARCH ---
const researchCases: Array<[string, string]> = [
  ["measured-haberi", "China's mysterious space plane exposed in new Pentagon images bu haberi acikla, nolmus"],
  ["measured-oku-anlat", "senin gorevin bu oku anlat"],
  ["measured-exa-deep-search", "olum sen salakmısın exa ile deep search yapsana mal"],
  ["measured-bilmiyosan", "lan bilmiyosan bak amk"],
  ["measured-bare-ara", "polonyayı ara"],
  ["measured-google-ara", "google'da ara"],
  ["measured-internette-bak", "internette bak polonya darbe"],
  ["measured-okuyup-anlat", "haberi okuyup anlat bana"],
  // locked v38 corpus (must hold)
  ["v38-1", "polonyada neler oluyor"],
  ["v38-2", "yani polonyada darbe oluyo ve sen bunu bulamıyo musun amk"],
  ["v38-3", "lan exa ile arasana"],
  ["v38-4", "haber sitelerine bak acil"],
  ["v38-5", "güncel durum ne türkiyede"],
  ["v38-6", "son dakika haberleri ver"],
];
for (const [label, p] of researchCases) {
  const got = classifyIntent(p);
  check(`A ${label}`, got === "RESEARCH", `got=${got} :: "${p}"`);
}

// --- B) Classifier: regressions must hold their lanes -----------------------
const regressCases: Array<[string, string]> = [
  ["break-idiom", "ara ver", "CHAT"],
  ["draw-araba", "araba çiz", "DRAW"],
  ["kanka-guard", "ne oluyo kanka", "CHAT"],
  ["kitap-oku", "kitap oku", "CHAT"],
  ["smalltalk", "nasılsın kanka", "CHAT"],
  ["self-ne-oluyorsun", "sen ne oluyorsun amk", "CHAT"],
  ["widget-guncelle", "widgeti güncelle", "CHAT"],
  ["arasinda", "bunun arasında ne var", "CHAT"],
  ["selffaq", "bugün ne yaptın", "CHAT"],
  // v38.5 — bare "durum ne" (no research topic) keeps its STATUS health answer
  ["bare-durum-status", "durum ne", "STATUS"],
  ["yogun-mu-status", "yoğun musun", "STATUS"],
];
for (const [label, p, expected] of regressCases) {
  const got = classifyIntent(p);
  check(`B ${label}`, got === expected, `got=${got} expected=${expected} :: "${p}"`);
}

// --- C) Sentinel parse: the [ARA: query] token contract ---------------------
check("C basic", parseAraSentinel("Bakayım kanka\n[ARA: Polonya darbe son durum]") === "Polonya darbe son durum");
check("C turkish", parseAraSentinel("[ARA: Çin uzay uçağı Pentagon görüntüleri]") === "Çin uzay uçağı Pentagon görüntüleri");
check("C empty-null", parseAraSentinel("[ARA:]") === null);
check("C one-char-null", parseAraSentinel("[ARA: a]") === null);
check("C no-sentinel-null", parseAraSentinel("selam kanka nasılsın") === null);
check(
  "C clamp-200",
  parseAraSentinel(`[ARA: ${"x".repeat(300)}]`) === "x".repeat(200),
  `len=${parseAraSentinel(`[ARA: ${"x".repeat(300)}]`)?.length ?? 0}`,
);
check("C first-of-two", parseAraSentinel("[ARA: ilk sorgu] ve [ARA: ikinci sorgu]") === "ilk sorgu");
check("C colon-no-space", parseAraSentinel("[ARA:x y z]") === "x y z");

// --- D) Residue: imperative-only detection inputs ---------------------------
const residueCases: Array<[string, string]> = [
  ["imperative-siteler", "haber sitelerine bak acil", "haber"],
  ["imperative-exa", "exa ile deep search yapsana mal", ""],
  ["imperative-oku-anlat", "senin gorevin bu oku anlat", ""],
  ["imperative-arasana", "lan exa ile arasana", ""],
  ["topic-kept", "polonyada darbe oluyo musun", "polonyada darbe oluyo musun"],
  ["kitap-kept", "kitap oku", "kitap"],
];
for (const [label, p, expected] of residueCases) {
  const got = researchResidue(p);
  check(`D ${label}`, got === expected, `got="${got}" expected="${expected}"`);
}

// --- E) Persona: the escalation rule + corrected self-model ------------------
const sys = buildSystemPrompt("izleyici", "specimba", "", false, null, "");
check("E ara-hatti-rule", sys.includes("ARA HATTI:"), "persona teaches the sentinel");
check("E sentinel-syntax", sys.includes("[ARA:"), "persona shows the literal token");
check("E old-denial-line-gone", !sys.includes("kendin panel açıp bakamazsın"), "the over-generalized limitation line is replaced");
check("E corrected-limits", sys.includes("panelleri ve kamerayı kendin açıp bakamazsın"), "correct limitation scope");
check("E denial-banned", sys.includes("YANLIŞ self-modeldir"), "the false-inability claims are explicitly banned");
check("E example-query", sys.includes("[ARA: Çin uzay uçağı Pentagon görüntüleri]"), "worked example for weak models");

// --- F) Relevance gate: tonight's measured false drops must rescue ---------
// F1 — the language-mismatch drop (Event 1793405042382: query "China
// mysterious space plane Pentagon images", on-topic TURKISH answer dropped).
const f1Answer = "Pentagon, Savunma İstihbarat Ajansı'nın (DIA) yeni raporunda Çin'in Shenlong uzay uçağını ilk kez bu kadar net gösterdiği görüntülere yer verdi.";
const f1Cites = "China's mysterious space plane exposed in new Pentagon images https://www.telegraph.co.uk/world-news/china-space-plane-pentagon/";
check("F citation-rescue", exaAnswerIsRelevant("China mysterious space plane Pentagon images", f1Answer, f1Cites) === true, "English tokens vs Turkish answer, English citations present");
check("F citation-miss-drops", exaAnswerIsRelevant("China mysterious space plane Pentagon images", f1Answer, "unrelated source about gardening tools") === false, "unrelated citations do not rescue");
// F2 — the Turkish suffix stem: "polonyada" in the query must emit the
// "polonya" stem so a topical answer can match (Event 1793397632503: the
// on-topic Poland answer scored ZERO hits because the suffixed token can
// never substring-match its own stem). A 1-hit answer still drops BY DESIGN
// (conservative gate — the z-ai fallback ladder owns that tier); the stem
// moves 0-hit topical answers to 1 hit and 2-hit topical answers to PASS.
check("F stem-variant-emitted", researchQueryTokens("polonyada neler oluyor").includes("polonya"), "the stem rides alongside the suffixed token");
check(
  "F stem-answer-match",
  exaAnswerIsRelevant("polonyada darbe oldu mu", "Polonya'da askeri darbe yaşanmadı — hukuki ve siyasi bir yetki çatışması var.") === true,
  "stem + topical noun = 2 hits = PASS",
);
// F3 — a genuinely off-topic answer still drops (the gate's whole purpose).
check("F offtopic-still-drops", exaAnswerIsRelevant("nikolinayı öğren", "Pipe smoking is an art that requires patience and the right packing technique.") === false, "the Nikolina class stays dropped");

console.log(`\nv38.5 probe: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
