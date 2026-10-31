// v388-20261031-defect-probe — READONLY, zero live sends, zero model spend.
// The owner's 05:35-05:52 +03 paste ("nonsensical bullshitter"): every EDGE
// banter row was invented-simile soup ("çorap gibi", "çay bardağına uzay
// gemisi", "çöpçatan") AND the berxx "@mention neden hep boş yapıyor" row
// misrouted to RESEARCH, fabricating viewer psychology from the web.
// This probe locks:
//   A) classifyIntent: third-person why-banter with a chatter @mention → CHAT
//      (strong research shapes still win);
//   B) panel persona (buildSystemPrompt): simile ban present, the v35.3
//      "absürt benzetme" prescription GONE;
//   C) edge persona (static source read of edge/nexus-cortex/index.ts): the
//      same retune in lock-step (the babble rows were ALL this lane);
//   D) chat-class regression locks: the babble rows themselves classify CHAT
//      (they always did — the persona was the defect, not the router).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyIntent, buildSystemPrompt } from "../src/lib/brain/cortex";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
}

// --- A) Third-person why-banter with a chatter @mention → CHAT (v38.8) -----
const whyCases: Array<[string, string, string]> = [
  [
    "measured-berxx-row",
    "@Robotic_Darkelf_Jedi neden hep boş yapıyor kötü dediysek kötü uncharted oynucana gitsin gta oynasın",
    "CHAT",
  ],
  ["mention-why-short", "@berxx niye hep agresif laf ediyor", "CHAT"],
  ["mention-why-ascii", "@berxx neden oyun bozuyor", "CHAT"],
  ["mention-optative", "@berxx gitsin gta oynasın artık", "CHAT"],
  // Strong research shapes keep the grounded path even with a mention:
  ["mention-strong-kimdir", "@berxx erlik kimdir demişti ya", "RESEARCH"],
  ["mention-strong-haber", "@berxx polonyadaki son dakika haberini sor", "RESEARCH"],
  // Mention WITHOUT why/optative keeps normal routing:
  ["mention-plain-fallthrough", "@berxx polonyada neler oluyor dedi ya", "RESEARCH"],
];
for (const [label, p, expected] of whyCases) {
  const got = classifyIntent(p);
  check(`A ${label}`, got === expected, `got=${got} expected=${expected}`);
}

// --- B) Panel persona: simile ban in, "absürt benzetme" prescription out ----
const sys = buildSystemPrompt("izleyici", "specimba", "", false, null, "");
check("B simile-ban-present", sys.includes("UYDURMA BENZETME YASAK"), "persona bans invented similes");
check("B plain-answer-first", sys.includes("ÖNCE mesajın KENDİSİNE düz, net Türkçe cevap"), "plain-answer-first directive");
check("B old-prescription-gone", !sys.includes("Espri araçların: kelime oyunu, absürt benzetme"), "v35.3 simile prescription removed");
check("B sock-example-kept", sys.includes("çorap gibi"), "the measured sock example is named in the ban");
check(
  "B tavir-block-intact",
  sys.includes("HATA BİLDİRMİYORDUR") && sys.includes("roast) YASAK"),
  "v31.4/v35.3 TAVIR skeleton unchanged",
);

// --- C) Edge persona (static source read — the lane is a remote function) ---
const edgeSrc = readFileSync(
  join(process.cwd(), "edge", "nexus-cortex", "index.ts"),
  "utf8",
);
check("C edge-simile-ban", edgeSrc.includes("UYDURMA BENZETME YASAK"), "edge persona bans invented similes");
check("C edge-plain-first", edgeSrc.includes("ÖNCE DÜZ CEVAP"), "edge persona plain-answer-first");
check(
  "C edge-old-gone",
  !edgeSrc.includes("kelime oyunu, absürt benzetme, kendi AI-lığına"),
  "v35.3 edge prescription removed",
);
check("C edge-kimlik-kilit-intact", edgeSrc.includes("KİMLİK KİLİDİ"), "identity lock untouched");

// --- D) The babble rows themselves stay CHAT (router was never the defect) --
const chatCases: Array<[string, string]> = [
  ["sock-lag", "vyce bağlantısında lag var sesin kesik kesik geliyor"],
  ["tea-stories", "hikayeleri cok iyi degil mi"],
  ["yasa-be", "yasa be"],
  ["trash-opinion", "uncharted çöp bir oyun"],
  ["agree-banter", "banada oyle geldi, iyi dedin."],
];
for (const [label, p] of chatCases) {
  const got = classifyIntent(p);
  check(`D ${label}`, got === "CHAT", `got=${got} expected=CHAT`);
}

console.log(`\nALL PASS — pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
