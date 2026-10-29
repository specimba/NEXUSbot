// probe-v368-guards.ts — v36.8 "still dumb" batch verification.
//
// Part A (deterministic, zero-cost): classifyIntent routing for the four
// measured defect classes + scrub-regex parity between the panel cleanReply
// and the edge sanitize (both must cut the enerji-clause family).
//
// Part B (live, cheap): the three deterministic/cheap rows against
// /api/brain/cortex — tweet-URL slip, self-name identity lane, self-reply
// question route-lock, self-model register. No Exa spend; chat rows run the
// GLM flash lane only.
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
const { classifyIntent } = await import("../src/lib/brain/cortex.ts");

// A1. URL-SLIP GUARD — the measured tweet link must NOT hit the STATUS tool
// (it shipped the internal diagnostics report "Groq anahtarsız · panik yok"
// into live chat). A bare tweet URL is RESEARCH (urlAnswer fetch).
const tweetUrl = "https://x.com/huyde12/status/1609292008895713280";
check(
  "A1 url-slip: tweet link → RESEARCH (was STATUS)",
  classifyIntent(tweetUrl) === "RESEARCH",
  `got ${classifyIntent(tweetUrl)}`,
);

// A2. Regression: the URL-strip must not break real smalltalk/status rows.
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

// A3. SELF-REPLY QUESTIONS — "yoğunluk yoksa neden cevap vermiyosun" hit
// \bneden\b → RESEARCH and Exa answered as a third-person advice column.
// Second-person "-yorsun/-sun" reply questions are persona work: CHAT.
check(
  "A3 self-replyq: 'yoğunluk yoksa neden cevap vermiyosun' → CHAT",
  classifyIntent("yoğunluk yoksa neden cevap vermiyosun") === "CHAT",
  `got ${classifyIntent("yoğunluk yoksa neden cevap vermiyosun")}`,
);
check(
  "A3b self-replyq: 'neden susuyorsun' → CHAT",
  classifyIntent("neden susuyorsun") === "CHAT",
  `got ${classifyIntent("neden susuyorsun")}`,
);
// Regression: real research "neden" questions keep their tier.
check(
  "A3c regression: 'gökyüzü mavi neden' stays CHAT/RESEARCH (not STATUS)",
  ["CHAT", "RESEARCH"].includes(classifyIntent("gökyüzü neden mavi")),
  `got ${classifyIntent("gökyüzü neden mavi")}`,
);

// A4. BANNED-REGISTER SCRUB — regex parity between panel cleanReply and edge
// sanitize (same literal in both). The OSS-120b hedge paraphrased the v36.6
// ban ("enerjim hiç bitmez" → "VYCE'in enerjisi hiç bitmez!"). First cut
// shipped a no-op regex (one-char possessive class) — this is the fixed,
// probe-verified literal.
const SCRUB_RE =
  /\s*[;,—–-]?\s*\S{0,30}\s*enerji(?:m|n|s[ıi]|m[ıi]z|n[ıi]z)?\s*(?:hi[çc]\s+)?(?:bitmez|t[üu]kenmez)[^.!?\n]*/gi;
const scrub = (s: string) => s.replace(SCRUB_RE, "");
check(
  "A4a scrub: 'Müsaitim, sor bakalım; VYCE'in enerjisi hiç bitmez!' loses the enerji clause",
  !/enerji/i.test(scrub("Müsaitim, sor bakalım; VYCE'in enerjisi hiç bitmez!")) &&
    scrub("Müsaitim, sor bakalım; VYCE'in enerjisi hiç bitmez!").startsWith("Müsaitim"),
  `got "${scrub("Müsaitim, sor bakalım; VYCE'in enerjisi hiç bitmez!")}"`,
);
check(
  "A4b scrub: 1st person 'enerjim hiç bitmez!' variant also cut",
  !/enerji/i.test(scrub("Hallettik chief; enerjim hiç bitmez!")),
  `got "${scrub("Hallettik chief; enerjim hiç bitmez!")}"`,
);
check(
  "A4c scrub: 'enerjisi tükenmez' family covered",
  !/enerji/i.test(scrub("Tamam kanka; enerjisi tükenmez bu botun.")),
  `got "${scrub("Tamam kanka; enerjisi tükenmez bu botun.")}"`,
);
check(
  "A4d scrub: clean replies untouched",
  scrub("Chief, sor bakalım; cevap yolda.") ===
    "Chief, sor bakalım; cevap yolda.",
  `got "${scrub("Chief, sor bakalım; cevap yolda.")}"`,
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
    `\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} label=${j.modelLabel}`,
  );
  console.log(`  reply: "${String(j.reply ?? "")}"`);
  return j;
}

// B1. EXACT measured tweet-link row → must never be the diagnostics STATUS
// lane; no internal infra vocabulary in the reply.
const b1 = await probe("B1 tweet-url", { sender: "v368probe-a", prompt: tweetUrl });
check(
  "B1 tweet-url: route is not cortex-status",
  String(b1.route) !== "cortex-status",
  `route=${b1.route}`,
);
check(
  "B1b tweet-url: no infra dump in reply",
  !/groq|panik yok|exa silahlı|statik hat/i.test(String(b1.reply ?? "")),
);

// B2. EXACT measured self-name row ("vyce nedir" — Exa answered with the
// real-world Vyce construction SaaS) → deterministic identity lane.
const b2 = await probe("B2 vyce-nedir", { sender: "v368probe-b", prompt: "vyce nedir" });
check(
  "B2 vyce-nedir: deterministic identity lane (tool:identity / cortex-who)",
  String(b2.modelId) === "tool:identity" || String(b2.route) === "cortex-who",
  `route=${b2.route} engine=${b2.modelId}`,
);
check(
  "B2b vyce-nedir: no SaaS/workforce/platform register",
  !/iş gücü|bordro|platform|inşaat|yönetim sistemi|süreçleri otomatik/i.test(String(b2.reply ?? "")),
);

// B3. EXACT measured self-reply question → CHAT family, never research/Exa.
const b3 = await probe(
  "B3 self-replyq",
  { sender: "v368probe-c", prompt: "yoğunluk yoksa neden cevap vermiyosun" },
);
check(
  "B3 self-replyq: not routed to research/exa",
  !/cortex-research|exa/i.test(String(b3.route) + String(b3.modelLabel)),
  `route=${b3.route} label=${b3.modelLabel}`,
);
check(
  "B3b self-replyq: no third-person advice-column register",
  !/görmemiş olabilir|bildirimleri kaçırmış|ilgisizlik değil/i.test(String(b3.reply ?? "")),
);

// B4. EXACT measured self-model row → the old flat denial
// ("Ekstra bir panelim, geçmişim, entegrasyonum yok") is banned.
const b4 = await probe(
  "B4 self-model",
  { sender: "v368probe-d", prompt: "kick chat entegrasyonun var aç bak" },
);
check(
  "B4 self-model: no flat denial of panel/integration/memory",
  !/panelim yok|entegrasyonum yok|geçmişim yok|ekstra bir panelim/i.test(String(b4.reply ?? "")),
);

console.log(`\n=== ${fails === 0 ? "ALL PASS" : fails + " FAILURES"} ===`);
process.exit(fails === 0 ? 0 : 1);
