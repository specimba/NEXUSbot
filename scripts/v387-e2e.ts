// v387-e2e — LIVE panel-lane verification (zero Kick sends).
// Reproduces the measured 03:47-03:5x +03 defect rows WITH the same ladder
// bait, then asserts the v38.7 fix end-to-end:
//   A) "erlik kimdir" + tekmil/kimsin ladder  → bare query → clean grounded
//      answer (pre-fix: welded query → relevance-drop → 17s static).
//   B) "polonyada neler oluyor" + space-plane ladder → Poland answer WITHOUT
//      the previous topic's entities (pre-fix: the space-plane mix).
//   C) "yönetmeni kim" + Hardcore Henry ladder → enrichment STILL carries the
//      topic (v29.22 lock — the fragment path must not regress).
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!pass) throw new Error("PANEL_PASSWORD missing");
const base = "http://localhost:3000";

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (login.status !== 200) throw new Error(`login ${login.status}`);
console.log("login: 200");

async function probe(label: string, prompt: string, memoryTurns: Array<{ role: string; content: string }>) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sender: "v387probe", prompt, memoryTurns, channel: "specimba" }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  const ms = Date.now() - t0;
  console.log(`\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} web=${(j.telemetry as Record<string, unknown>)?.webSearch} ${ms}ms`);
  console.log(`  reply: "${String(j.reply ?? "").slice(0, 220)}"`);
  return { j, ms };
}

// A) the erlik class — same bait as the live 03:47 +03 row
const a = await probe("A erlik+bait", "erlik kimdir", [
  { role: "user", content: "tekmil ver" },
  { role: "assistant", content: "Tekmil: buradayım, muhabbet açık." },
  { role: "user", content: "kimsin nerdensin bunlar eksik boyle tekmil olmaz" },
  { role: "assistant", content: "Haklısın, eksiksiz veriyorum: VYCE." },
]);
const aReply = String(a.j.reply ?? "").toLowerCase();
check("A1 grounded lane (exa or synthesis, not static)", String(a.j.modelId) !== "web-fallback" && String(a.j.modelId) !== "static-floor", `engine=${a.j.modelId}`);
check("A2 on-topic Erlik answer", /erlik/.test(aReply) && /mitoloji|tanrı|tanri|yeraltı|yeralti|tengri/.test(aReply), String(a.j.reply).slice(0, 120));
check("A3 no welded-bait tokens in the answer", !/tekmil|nerdensin/.test(aReply), "");
check("A4 latency sane (<15s)", a.ms < 15_000, `${a.ms}ms`);

// B) the polonya class — space-plane bait (the measured 03:5x mix)
const b = await probe("B polonya+bait", "polonyada neler oluyor", [
  { role: "user", content: "China's mysterious space plane exposed in new Pentagon images bu haberi acikla, nolmus" },
  { role: "assistant", content: "Pentagon görüntülerini açıklayamadım." },
]);
const bReply = String(b.j.reply ?? "").toLowerCase();
check("B1 on-topic Poland answer", /polonya|poland|varşova|varsava|tusk|nawrocki/.test(bReply), String(b.j.reply).slice(0, 140));
check("B2 NO previous-topic entities (the drift guard)", !/shenlong|uzay uçağı|uzay ucagi|pentagon|x-37/.test(bReply), "");
check("B3 latency sane (<15s)", b.ms < 15_000, `${b.ms}ms`);

// C) v29.22 fragment lock — enrichment must still carry the topic
const c = await probe("C fragment lock", "yönetmeni kim", [
  { role: "user", content: "dün Hardcore Henry izledik yayında" },
  { role: "assistant", content: "İzleme listesine aldım." },
]);
const cReply = String(c.j.reply ?? "").toLowerCase();
check("C1 fragment enrichment carries the topic", /naishuller|hardcore henry|henry/.test(cReply), String(c.j.reply).slice(0, 140));
check("C2 not a refusal/static", !/bilmiyorum|bilemem|söyleyemem|model sıkıştı/.test(cReply), "");

console.log(`\n${fails === 0 ? "=== ALL PASS ===" : `=== ${fails} FAIL ===`}`);
process.exit(fails === 0 ? 0 : 1);
