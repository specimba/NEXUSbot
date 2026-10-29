// probe-v369-guards.ts — v36.9 "literally 0 memory usefulness" batch.
//
// Part A (deterministic, zero-cost): classifyIntent routing for the
// SELF-CLAIM + TAUNT families (the "dedin" hijack row), regressions for the
// v36.8 locks and the research/time/status families, and unit checks on the
// NEW channel-wide exchange ring + the plain-chat lines ring (the cross-
// sender memory window).
//
// Part B (live, cheap): the exact measured hijack row, plus the GOLDEN
// cross-sender memory test — viewer A talks about çay/rulokat, a DIFFERENT
// viewer B asks what the çay talk was: the reply must resolve from the
// channel-wide ladder, not claim ignorance. No Exa spend; chat rows run the
// GLM flash lane only. Zero Kick footprint (panel cortex API only).
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!pass) throw new Error("PANEL_PASSWORD missing");
const base = "http://localhost:3000";

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

// ---------------------------------------------------------------------------
// PART A — deterministic unit checks
// ---------------------------------------------------------------------------
const cortex = await import("../src/lib/brain/cortex.ts");
const {
  classifyIntent,
  cortexConvoAppend,
  cortexConvoTurns,
  cortexConvoChannelTurns,
  cortexChatLineAppend,
  cortexChatLinesSnapshot,
} = cortex;

// A1. SELF-CLAIM LOCK — the exact measured hijack row (was RESEARCH → the
// Exa Duman-band confabulation). Quoting the bot's own words back at it is
// persona conversation, never web research.
const measuredRow = "lan çayın dumanı dedin nasıl bir salaksın sen";
check(
  "A1 self-claim: measured 'dedin' row → CHAT (was RESEARCH)",
  classifyIntent(measuredRow) === "CHAT",
  `got ${classifyIntent(measuredRow)}`,
);
check(
  "A1b taunt: 'nasıl bir salaksın sen' → CHAT",
  classifyIntent("nasıl bir salaksın sen") === "CHAT",
  `got ${classifyIntent("nasıl bir salaksın sen")}`,
);
check(
  "A1c self-claim: 'bunu sen mi söyledin' → CHAT",
  classifyIntent("bunu sen mi söyledin") === "CHAT",
  `got ${classifyIntent("bunu sen mi söyledin")}`,
);

// A2. Regressions — research/time/status families keep their tiers.
check(
  "A2a regression: 'saat kaç' stays TIME",
  classifyIntent("saat kaç") === "TIME",
  `got ${classifyIntent("saat kaç")}`,
);
check(
  "A2b regression: 'meşgul müsün' stays STATUS",
  classifyIntent("meşgul müsün") === "STATUS",
  `got ${classifyIntent("meşgul müsün")}`,
);
check(
  "A2c regression: 'terra kim?' stays RESEARCH (web entity)",
  classifyIntent("terra kim?") === "RESEARCH",
  `got ${classifyIntent("terra kim?")}`,
);
check(
  "A2d regression: 'wow badge nasıl alınır' stays RESEARCH",
  classifyIntent("wow badge nasıl alınır") === "RESEARCH",
  `got ${classifyIntent("wow badge nasıl alınır")}`,
);
check(
  "A2e regression: 'cevap vermiyosun' stays CHAT (v36.8 hold)",
  classifyIntent("yoğunluk yoksa neden cevap vermiyosun") === "CHAT",
  `got ${classifyIntent("yoğunluk yoksa neden cevap vermiyosun")}`,
);

// A3. CHANNEL-WIDE EXCHANGE RING — the exact live failure shape: A's
// exchange (incl. the bot's own "dumanına bakarım" reply) must be visible to
// a DIFFERENT viewer B through the channel window, while B's own sender
// thread stays isolated (dedupe happens at the runCortex merge point, not
// in the reader).
const probeChan = "v369probe-chan";
cortexConvoAppend(probeChan, "yavuzerdem99", "eyvo aicim", "Eyvallah kanka, ben buradan dumanına bakarım.");
const bOwnThread = cortexConvoTurns(probeChan, "specimba", 12);
const chanWindow = cortexConvoChannelTurns(probeChan, 10);
check(
  "A3a channel ring: bot's own reply to A is visible in the channel window",
  chanWindow.some((t) => t.role === "assistant" && /dumanına bakarım/.test(t.content)),
  `chanWindow roles: ${chanWindow.map((t) => t.role).join(",")}`,
);
check(
  "A3b channel ring: A's user turn carries the @sender prefix",
  chanWindow.some((t) => t.role === "user" && /@yavuzerdem99:/i.test(t.content)),
);
check(
  "A3c sender isolation: B's own thread still starts empty (fresh viewer)",
  bOwnThread.length === 0,
  `got ${bOwnThread.length} turns`,
);

// A4. CHAT-LINES RING — the plain-chatter transcript for the webhook path.
cortexChatLineAppend(probeChan, "yavuzerdem99", "bi çay aldim yanina da rulokat");
cortexChatLineAppend(probeChan, "GOAT", "POLICE");
const snap = cortexChatLinesSnapshot(probeChan, 14);
check(
  "A4a chat lines: snapshot contains both lines with sender prefixes",
  /yavuzerdem99:.*çay/i.test(snap) || /yavuzerdem99:.*rulokat/i.test(snap),
  `çay check — got "${snap}"`,
);
check(
  "A4b chat lines: second line present",
  /GOAT: POLICE/.test(snap),
  `got "${snap}"`,
);

// ---------------------------------------------------------------------------
// PART B — live rows (login + /api/brain/cortex)
// ---------------------------------------------------------------------------
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
console.log(`\nlogin: ${login.status}`);

async function probe(label: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as Record<string, unknown>;
  console.log(
    `\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} label=${j.modelLabel} memory=${j.memoryUsed}`,
  );
  console.log(`  reply: "${String(j.reply ?? "")}"`);
  return j;
}

// B1. EXACT measured hijack row → CHAT family, never research/Exa; no
// Duman-band confabulation register in the reply.
const b1 = await probe("B1 self-claim", { sender: "v369probe-a", prompt: measuredRow });
check(
  "B1 self-claim: not routed to research/exa",
  !/cortex-research|exa/i.test(String(b1.route) + String(b1.modelLabel)),
  `route=${b1.route} label=${b1.modelLabel}`,
);
check(
  "B1b self-claim: no Duman-band essay register",
  !/Duman.{0,30}(şarkı|grup|nakarat)|Salaksın.{0,40}nakarat|Geçmiş konuşmada/i.test(String(b1.reply ?? "")),
  String(b1.reply ?? ""),
);

// B2. CROSS-SENDER MEMORY (the golden test of the owner complaint): viewer A
// mentions çay/rulokat; a DIFFERENT viewer B asks about the çay talk — the
// reply must resolve from the channel-wide ladder (mention çay/rulokat),
// not the old "bana tek satır geldi" ignorance register.
const stamp = Date.now().toString().slice(-4);
const memA = `v369mema-${stamp}`;
const memB = `v369memb-${stamp}`;
const b2a = await probe("B2a cross-sender seed", {
  sender: memA,
  prompt: "az önce çay demledim yanına da rulokat koydum keyfime bakıyorum",
});
check(
  "B2a seed: answered ok (not rate-guarded)",
  String(b2a.route) !== "cortex-rate" && String(b2a.reply ?? "").length > 10,
  `route=${b2a.route}`,
);
// give the ring append a beat, then a FRESH viewer asks about the talk
await new Promise((r) => setTimeout(r, 500));
const b2b = await probe("B2b cross-sender memory", {
  sender: memB,
  prompt: "az önce burda çay muhabbeti neydi",
});
const b2bReply = String(b2b.reply ?? "");
check(
  "B2b cross-sender: reply resolves the çay/rulokat context",
  /çay|rulokat|deml/i.test(b2bReply),
  `reply: "${b2bReply}"`,
);
check(
  "B2c cross-sender: no 'only got one line' ignorance register",
  !/tek satır|sadece senin mesajın|başka bir şey görmüyorum|muhabbet görmüyorum|kayıt yok|hafızamda değil/i.test(b2bReply),
  `reply: "${b2bReply}"`,
);

// B3. Regression: the v36.8 deterministic identity lane holds.
const b3 = await probe("B3 vyce-nedir", { sender: "v369probe-c", prompt: "vyce nedir" });
check(
  "B3 vyce-nedir: deterministic identity lane holds",
  String(b3.modelId) === "tool:identity" || String(b3.route) === "cortex-who",
  `route=${b3.route} engine=${b3.modelId}`,
);

console.log(`\n=== ${fails === 0 ? "ALL PASS" : fails + " FAILURES"} ===`);
process.exit(fails === 0 ? 0 : 1);
