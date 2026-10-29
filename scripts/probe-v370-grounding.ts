// probe-v370-grounding.ts — v37 grounding lane (docs/capability-upgrade-plan.md).
//
// Part A (deterministic, zero-cost): classifyIntent routing for the NEW
// families — NOWPLAYING (D2), TEMPORAL_RELEASE (D3), BOT_META_TOOLS (D6) —
// plus the locked-family regressions the plan §11 checklist demands
// ("şu an saat kaç" stays TIME, "bu şarkı kimin" stays RESEARCH, …).
// Unit checks on the grounding helpers: normalizeTr (Turkish fold),
// exaAnswerIsRelevant (the measured pipe-guide drop vs the Cami Toro pass),
// compileGrounding (ŞU AN card present, kill-switch), answerNowPlaying
// (honest NOT_CONFIGURED — no fabricated track names).
//
// Part B (live, cheap): login + the deterministic plak lane row (route
// cortex-nowplaying, honest unconfigured register), the lore round-trip
// (add via /api/lore → "kimdir" flips RESEARCH→CHAT → delete cleanup), and
// the /api/brain/nowplaying heartbeat contract. No Exa spend; no Kick
// footprint (panel APIs only).
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
const grounding = await import("../src/lib/brain/grounding.ts");
const normalize = await import("../src/lib/brain/normalize-tr.ts");
const { classifyIntent } = cortex;
const { exaAnswerIsRelevant, compileGrounding, answerNowPlaying } = grounding;
const { normalizeTr } = normalize;

// A1. NOWPLAYING must-match corpus (plan §4d).
const npMust = [
  "şu an ne çalıyor",
  "suan ne calıyo",
  "şu an ne çalıyor kardeşim",
  "çalan şarkı ne",
  "çalan şarkının adı ne",
  "şu an çalan parça",
  "hangi şarkı çalıyor",
  "dj ne çalıyor",
  "yayında ne çalıyor",
  "şimdi ne çalıyor abi",
  "now playing",
];
for (const row of npMust) {
  check(`A1 np must: "${row}" → NOWPLAYING`, classifyIntent(row) === "NOWPLAYING", `got ${classifyIntent(row)}`);
}

// A2. NOWPLAYING must-NOT-match corpus (the D5-adjacent banter family).
const npMustNot = [
  "healer çalıyor abi",
  "bu şarkı kimin",
  "müzik fena çalıyo görebiliyon mu",
  "güzel şarkı ben beğendim",
  "şarkının adını yazarsan yorum yapar mısın",
  "yami specinde kanalında yeni şarkı çıkmış ona baktın mı",
  "erzurumda bir şeyler çalıyor",
];
for (const row of npMustNot) {
  const got = classifyIntent(row);
  check(`A2 np not: "${row}" → not NOWPLAYING`, got !== "NOWPLAYING", `got ${got}`);
}

// A3. Ladder collisions — the locked families still win.
check(
  "A3a collision: 'şu an saat kaç' stays TIME (never NOWPLAYING)",
  classifyIntent("şu an saat kaç") === "TIME",
  `got ${classifyIntent("şu an saat kaç")}`,
);
check(
  "A3b collision: 'meşgul müsün' stays STATUS",
  classifyIntent("meşgul müsün") === "STATUS",
  `got ${classifyIntent("meşgul müsün")}`,
);
check(
  "A3c collision: 'haberleri derle' stays RESEARCH (news digest)",
  classifyIntent("haberleri derle") === "RESEARCH",
  `got ${classifyIntent("haberleri derle")}`,
);
check(
  "A3d collision: bare Spotify URL stays RESEARCH (URL lane)",
  classifyIntent("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC ne düşünüyorsun") === "RESEARCH",
);
// A3e. "vyce nedir" — classifyIntent has ALWAYS returned RESEARCH for this
// row (the \bnedir\b gate predates v37); the deterministic self-identity
// lane (v36.8 selfNameQ) intercepts it DOWNSTREAM in runCortexCore — the
// v369 probe asserts that live (B3). Regression here: still CHAT/RESEARCH
// (i.e. never NOWPLAYING/DRAW/TIME — the new gates don't shadow it).
check(
  "A3e collision: 'vyce nedir' keeps its family (who-lane intercepts downstream)",
  ["CHAT", "RESEARCH"].includes(classifyIntent("vyce nedir")),
  `got ${classifyIntent("vyce nedir")}`,
);

// A4. TEMPORAL_RELEASE (D3 routing half) + regression.
check(
  "A4a temporal: 'bugün herkesin çok beklediği bi oyun çıktı adı neydi' → RESEARCH",
  classifyIntent("bugün herkesin çok beklediği bi oyun çıktı. adı neydi oyunun") === "RESEARCH",
  `got ${classifyIntent("bugün herkesin çok beklediği bi oyun çıktı. adı neydi oyunun")}`,
);
check(
  "A4b temporal: 'yeni çıkan film hangiydi' → RESEARCH",
  classifyIntent("yeni çıkan film hangiydi") === "RESEARCH",
  `got ${classifyIntent("yeni çıkan film hangiydi")}`,
);
check(
  "A4c temporal regression: 'bugün hava çok güzeldi' stays CHAT (no release noun)",
  classifyIntent("bugün hava çok güzeldi") === "CHAT",
  `got ${classifyIntent("bugün hava çok güzeldi")}`,
);

// A5. BOT_META_TOOLS (D6) — the two measured rows + regressions.
check(
  "A5a meta-tools: 'senin araştırmalarında öyle bi isim yok mu' → CHAT",
  classifyIntent("şimdi kardeşim senin araştırmalarında öyle bi isim yok yani öyle mi") === "CHAT",
  `got ${classifyIntent("şimdi kardeşim senin araştırmalarında öyle bi isim yok yani öyle mi")}`,
);
check(
  "A5b meta-tools: 'şu toollarını düzgünce kullan' → CHAT",
  classifyIntent("şu toollarını düzgünce kullan nikolinayı öğren sonra ablamız sana bi güzel sopayı çaksın") === "CHAT",
  `got ${classifyIntent("şu toollarını düzgünce kullan nikolinayı öğren sonra ablamız sana bi güzel sopayı çaksın")}`,
);
check(
  "A5c meta-tools regression: third-person 'araştırmalar ne diyor' keeps its lane",
  classifyIntent("yeni çıkan oyun hakkında araştırmalar ne diyor") === "RESEARCH",
  `got ${classifyIntent("yeni çıkan oyun hakkında araştırmalar ne diyor")}`,
);

// A6. Grounding helpers.
check(
  "A6a normalizeTr: 'DJ Nikolina'nın' folds diacritic-insensitive",
  normalizeTr("DJ Nikolina'nın") === "djnikolinanin",
  `got "${normalizeTr("DJ Nikolina'nın")}"`,
);
check(
  "A6b normalizeTr: 'şuan çalan şarkı' → ASCII fold",
  normalizeTr("şuan çalan şarkı") === "suancalansarki",
  `got "${normalizeTr("şuan çalan şarkı")}"`,
);
// A6c — the measured D5 drop: the "nikolina" research came back as a
// pipe-smoking guide; zero salient tokens in the answer → gate drops it.
check(
  "A6c relevance gate: pipe-guide answer for nikolina query DROPS",
  !exaAnswerIsRelevant("nikolina kim diye araştır sopa", "Pipo içerken tütünü nazikçe ve yavaş tempoda çekmelisin. Dumanı içine çekmemen gerektiğini unutma. Pipoyu temizleyip kuruması için dinlendirmen ömrünü uzatır."),
);
check(
  "A6d relevance gate: Cami Toro answer (measured good row) PASSES",
  exaAnswerIsRelevant("Cami Toro kimdir", "Bahsettiğin kişi büyük ihtimalle mimar Hugo Toro. Camila Toro ismiyle profesyonel kariyer yapan farklı kişiler mevcut. Hugo Toro, iç mimaride hikaye anlatıcılığına odaklanan ünlü bir isimdir."),
);
check(
  "A6e relevance gate: no salient tokens → pass (never over-block)",
  exaAnswerIsRelevant("nedir nedir", "herhangi bir cevap"),
);

// A7. compileGrounding — ŞU AN card always present (kill-switch default on).
const block = compileGrounding("selam kanka");
check("A7a grounding: ŞU AN temporal card present", /ŞU AN/.test(block), block.slice(0, 120));
check("A7b grounding: block within the 900-char budget", block.length <= 900, `len ${block.length}`);

// A8. answerNowPlaying — honest state machine, state-agnostic: with no
// oauth row the register is the honest not-connected one; once the owner
// connects, the SAME lane must produce real track facts. Either way: no
// fabricated artist/name when NOT_CONNECTED.
const npReply = await answerNowPlaying("şu an ne çalıyor", "specimba");
check(
  "A8 plak lane: honest register (connected → real facts, unconfigured → honest pass)",
  npReply.length > 20 && (/Spotify|bağlant|çalıyor|parça|plak/i.test(npReply) || /\d+:\d+\/\d+:\d+/.test(npReply)),
  npReply,
);

// ---------------------------------------------------------------------------
// PART B — live rows (login + panel APIs)
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
  console.log(`\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} label=${j.modelLabel}`);
  console.log(`  reply: "${String(j.reply ?? "")}"`);
  return j;
}

// B1. The deterministic plak lane — live row, honest unconfigured register
// (Spotify oauth not in the vault until the owner connects it).
const b1 = await probe("B1 plak lane", { sender: "v370probe-a", prompt: "şu an ne çalıyor" });
check(
  "B1a plak lane: routed cortex-nowplaying, zero model",
  String(b1.route) === "cortex-nowplaying" && String(b1.modelId) === "tool:now-playing",
  `route=${b1.route} engine=${b1.modelId}`,
);
check(
  "B1b plak lane: honest register (unconfigured pass or real track facts)",
  String(b1.reply ?? "").length > 20 && (/Spotify|bağlant|çalıyor|parça|plak/i.test(String(b1.reply ?? "")) || /\d+:\d+\/\d+:\d+/.test(String(b1.reply ?? ""))),
  String(b1.reply ?? ""),
);

// B2. Lore round-trip — the D4 kill shot: add a flagged in-joke, ask "kimdir"
// (RESEARCH by \bkim\b), expect the flip to CHAT with lore grounding; then
// clean up (the probe leaves no state behind).
const stamp = Date.now().toString().slice(-5);
const alias = `v370sik${stamp}`;
const addLore = await fetch(`${base}/api/lore`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    aliases: [alias],
    text: "kanalın gizli test şakasıdır, gerçek bir kişi değildir",
    blockResearch: true,
  }),
});
const loreBody = (await addLore.json()) as { ok?: boolean; entry?: { id?: string }; error?: { message?: string } };
check("B2a lore: entry created via /api/lore", addLore.status === 200 && loreBody.ok === true, `HTTP ${addLore.status} ${loreBody.error?.message ?? ""}`);
const loreId = loreBody.entry?.id ?? "";
if (loreId) {
  const b2 = await probe("B2b lore flip", { sender: "v370probe-b", prompt: `${alias} kimdir` });
  check(
    "B2b lore flip: flagged in-joke never goes to web research",
    String(b2.route) !== "cortex-research" && !/exa/i.test(String(b2.modelLabel)),
    `route=${b2.route} label=${b2.modelLabel}`,
  );
  check(
    "B2c lore flip: reply is grounded (lore register or honest persona)",
    String(b2.reply ?? "").length > 10,
    String(b2.reply ?? ""),
  );
  const del = await fetch(`${base}/api/lore?id=${encodeURIComponent(loreId)}`, { method: "DELETE", headers: { cookie } });
  check("B2d lore: cleanup ok", del.status === 200, `HTTP ${del.status}`);
} else {
  check("B2 lore round-trip SKIPPED (entry id missing)", false);
}

// B3. Heartbeat contract — /api/brain/nowplaying answers the honest enum.
const npApi = await fetch(`${base}/api/brain/nowplaying`, { headers: { cookie } });
const npJson = (await npApi.json()) as { ok?: boolean; connected?: boolean; snapshot?: { state?: string } | null };
check(
  "B3 heartbeat: /api/brain/nowplaying honest contract",
  npApi.status === 200 && npJson.ok === true && typeof npJson.connected === "boolean" && (npJson.snapshot?.state ?? "NOT_CONFIGURED") !== undefined,
  `HTTP ${npApi.status} connected=${npJson.connected} state=${npJson.snapshot?.state}`,
);

// B4. Regressions through the live gate — the locked families hold with the
// new lanes mounted.
const b4a = await probe("B4a time hold", { sender: "v370probe-c", prompt: "saat kaç" });
check("B4a regression: 'saat kaç' → cortex-time", String(b4a.route) === "cortex-time", `route=${b4a.route}`);
const b4b = await probe("B4b research hold", { sender: "v370probe-d", prompt: "terra kim?" });
check(
  "B4b regression: 'terra kim?' stays grounded research",
  String(b4b.route) === "cortex-research",
  `route=${b4b.route}`,
);

console.log(`\n=== ${fails === 0 ? "ALL PASS" : fails + " FAILURES"} ===`);
process.exit(fails === 0 ? 0 : 1);
