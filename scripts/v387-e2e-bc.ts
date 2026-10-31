// v387-e2e part 2 — B (polonya drift guard) + C (v29.22 fragment lock),
// distinct senders + spacing to clear the panel rate guard.
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
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (login.status !== 200) throw new Error(`login ${login.status}`);
async function probe(label: string, sender: string, prompt: string, memoryTurns: Array<{ role: string; content: string }>) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sender, prompt, memoryTurns, channel: "specimba" }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  const ms = Date.now() - t0;
  console.log(`\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} ${ms}ms`);
  console.log(`  reply: "${String(j.reply ?? "").slice(0, 240)}"`);
  return { j, ms };
}
const b = await probe("B polonya+bait", "v387probeB", "polonyada neler oluyor", [
  { role: "user", content: "China's mysterious space plane exposed in new Pentagon images bu haberi acikla, nolmus" },
  { role: "assistant", content: "Pentagon görüntülerini açıklayamadım." },
]);
const bReply = String(b.j.reply ?? "").toLowerCase();
check("B1 on-topic Poland answer", /polonya|poland|varşova|varsava|tusk|nawrocki|anayasa/.test(bReply), String(b.j.reply).slice(0, 160));
check("B2 NO previous-topic entities (the drift guard)", !/shenlong|uzay uçağı|uzay ucagi|pentagon|x-37|dünya dışı|dunya disi/.test(bReply), "");
check("B3 latency sane (<15s)", b.ms < 15_000, `${b.ms}ms`);
await new Promise((r) => setTimeout(r, 4000));
const c = await probe("C fragment lock", "v387probeC", "yönetmeni kim", [
  { role: "user", content: "dün Hardcore Henry izledik yayında" },
  { role: "assistant", content: "İzleme listesine aldım." },
]);
const cReply = String(c.j.reply ?? "").toLowerCase();
check("C1 fragment enrichment carries the topic", /naishuller|hardcore henry|henry/.test(cReply), String(c.j.reply).slice(0, 160));
check("C2 not a refusal/static", !/bilmiyorum|bilemem|söyleyemem|model sıkıştı|sıkışt/.test(cReply), "");
console.log(`\n${fails === 0 ? "=== ALL PASS ===" : `=== ${fails} FAIL ===`}`);
process.exit(fails === 0 ? 0 : 1);
