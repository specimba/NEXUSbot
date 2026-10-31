// v387-e2e part 3 — fragment lock retest on a FRESH channel (the specimba
// ring carried probe rows A/B into C's ladder; the ring is per-channel).
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
const t0 = Date.now();
const r = await fetch(`${base}/api/brain/cortex`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ sender: "v387probeC2", prompt: "yönetmeni kim", channel: "v387test",
    memoryTurns: [
      { role: "user", content: "dün Hardcore Henry izledik yayında" },
      { role: "assistant", content: "İzleme listesine aldım." },
    ] }),
});
const j = (await r.json()) as Record<string, unknown>;
const ms = Date.now() - t0;
console.log(`C2: status=${r.status} route=${j.route} engine=${j.modelId} ${ms}ms`);
console.log(`  reply: "${String(j.reply ?? "").slice(0, 240)}"`);
const cReply = String(j.j?.reply ?? j.reply ?? "").toLowerCase();
check("C1 fragment enrichment carries the topic (fresh channel)", /naishuller|hardcore henry|henry/.test(cReply), String(j.reply).slice(0, 180));
check("C2 not a refusal/static", !/bilmiyorum|bilemem|söyleyemem|sıkışt/.test(cReply), "");
check("C3 no foreign-topic entities", !/erlik|polonya|pentagon/.test(cReply), "");
console.log(`\n${fails === 0 ? "=== ALL PASS ===" : `=== ${fails} FAIL ===`}`);
process.exit(fails === 0 ? 0 : 1);
