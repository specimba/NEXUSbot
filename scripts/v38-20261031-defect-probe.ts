// v38-20261031-defect-probe — READONLY. Two jobs, zero side effects:
//   A) Static verification of the v38 RESEARCH_RE current-events shapes
//      (replicated regex + guard order — NOT a live cortex call, so no model
//      or Exa spend; the live classifier is the same order in cortex.ts).
//   B) Post-restore intactness counts (bun:sqlite readonly) — answers the
//      owner's "is everything intact?" with numbers.
import { Database } from "bun:sqlite";

// --- A) v38 routing shapes (copied verbatim from cortex.ts v38) -------------
const RESEARCH_RE =
  /(araştır|arastir|gündem|gundem|son\s*dakika|en\s*son|yeni\s*çıkan|yeni\s*cikan|\bhaber\b|\bkimdir\b|kim\s*bu|\bkim\b|\bnedir\b|\bnasıl\b|\bnasil\b|\bniçin\b|\bneden\b|\bne\s*oldu\b|(?:neler|ne)\s*oluyo(?:r)?\b|ne\s*d[öo]n[uü]yor|oluyo(?:r)?\s*m[ıi]\b|son\s*durum|g[uü]ncel(?:\s*(?:durum|bilgi|veri|haber))?\b|bulam[ıi]y(?:o|or)|aras[ıia]na\b|hakk[ıi]nda|kaç\s*tl|kac\s*tl|\bfiyat\b|\bskor\b|maç|\bbitcoin\b|\bdolar\b|\beuro\b|\baltın\b|hava\s*durumu|\bwhen\b|\bwho\s*is\b|\bwhat\s*is\b|\bhow\s*(?:to|do)\b|\bnews\b|\blatest\b|\bprice\b|\bscore\b)/i;
const SMALLTALK_RE =
  /(?:nasılsın|nasilsin|naber|ne\s*haber|nasıl\s*gidiyor|nasil\s*gidiyor|nasıl\s*gidiyorsun|kendini\s*nasıl|hissediyorsun|hissediyorum|keyifler\s*nasıl|iyi\s*müsün|iyimisin|iyimisiniz|kanki|kanka|nasıl\s*durumlar|nasil\s*durumlar|durumlar\s*(?:nasıl|nasil|ne)|ne\s*alemde|ne\s*ayaks[ıi]n|nabıyon|nerden\s*bakıyorsun)/i;
const SELF_REPLYQ_RE =
  /\b(?:cevap\s*ver|yaz|konu[sş]|d[öo]n|bak|sus)[a-zçğıöşü]{0,6}(?:[sş]?[ıiuü]n|y[ou]n)\b|\b(?:n[ıi]ye|neden|ni[çc]e)\s+sus\b|\b(?:dedin|dediysen|diyon|diyosun|diyorsun|demi[sş](?:sin|tin)|s[öo]yledin|s[öo]yl[üu]yorsun|s[öo]yl[üu]yosun)\b|\b(?:salak|aptal|gerizekal[ıi]|embesil|enayi)\s*s[ıi]n\b/i;

// Guard order replica (classify() relevant slice): guards BEFORE RESEARCH_RE.
function classifyExpect(p: string): string {
  const ifSmall = p.length <= 80 && SMALLTALK_RE.test(p) ? "CHAT" : null;
  const ifSelf = p.length <= 140 && SELF_REPLYQ_RE.test(p) ? "CHAT" : null;
  const research = RESEARCH_RE.test(p) ? "RESEARCH" : "CHAT";
  return ifSmall ?? ifSelf ?? research;
}

const rows: Array<[string, string, string]> = [
  // [label, prompt, expected]
  ["measured-1", "polonyada neler oluyor", "RESEARCH"],
  ["measured-2", "yani polonyada darbe oluyo ve sen bunu bulamıyo musun amk", "RESEARCH"],
  ["measured-3", "lan exa ile arasana", "RESEARCH"],
  ["measured-4", "haber sitelerine bak acil", "RESEARCH"],
  ["regress-1", "sen ne oluyorsun amk", "CHAT"],
  ["regress-2", "nasılsın kanka", "CHAT"],
  ["regress-3", "ne oluyo kanka", "CHAT"],
  ["regress-4", "widgeti güncelle", "CHAT"],
  ["regress-5", "bunun arasında ne var", "CHAT"],
  ["regress-6", "bugün ne yaptın", "CHAT"],
  ["regress-7", "güncel durum ne türkiyede", "RESEARCH"],
  ["regress-8", "son dakika haberleri ver", "RESEARCH"],
];
let pass = 0;
for (const [label, prompt, expected] of rows) {
  const got = classifyExpect(prompt);
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: got=${got} expected=${expected} :: "${prompt}"`);
}
console.log(`regex suite: ${pass}/${rows.length}`);

// --- B) Post-restore intactness (readonly) ----------------------------------
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const count = (t: string): number => {
  try {
    return (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  } catch {
    return -1;
  }
};
const stats = [
  ["Event", count("Event")],
  ["InteractionLog", count("InteractionLog")],
  ["Credential", count("Credential")],
  ["Widget", count("Widget")],
  ["IngestToken", count("IngestToken")],
  ["Setting", count("Setting")],
  ["RsiCycle", count("RsiCycle")],
  ["RsiRun", count("RsiRun")],
  ["RsiSuite", count("RsiSuite")],
] as const;
for (const [t, n] of stats) console.log(`${t}: ${n}`);

// Lore state (Setting key brain.lore) — seal-restored or empty?
try {
  const row = db
    .query("SELECT value FROM Setting WHERE key = 'brain.lore'")
    .get() as { value: string } | null;
  if (!row) {
    console.log("lore: NO Setting row (empty lorebook — pre-seal entries not in the 00:48 seal)");
  } else {
    const parsed = JSON.parse(row.value) as unknown;
    const n = Array.isArray(parsed) ? parsed.length : -1;
    console.log(`lore: ${n} entries in Setting brain.lore`);
  }
} catch (e) {
  console.log(`lore: read failed — ${e instanceof Error ? e.message : "unknown"}`);
}
db.close();
