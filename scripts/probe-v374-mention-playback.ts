// probe-v374-mention-playback.ts — live A/B verification of the mention≠playback
// grounding rule (v37.4). Panel test lane ONLY (/api/brain/cortex post-login);
// zero Kick footprint, no lore writes, no vault touches.
//
// A) Replay the EXACT message that failed live at 04:18 ("Venüs — Ben Senden
//    Vazgeçtim (Official Video)") → the reply must NOT claim "Venüs dinliyoruz"
//    while the card says another track; must frame the title as a mention and
//    name the real card track (or clearly separate the two).
// B) Control: "şu an ne çalıyor" still hits the deterministic plak lane.
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!pass) throw new Error("PANEL_PASSWORD missing");
const base = "http://localhost:3000";

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
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

// Ground truth: what does the card say right now?
const np = await fetch(`${base}/api/brain/nowplaying`, { headers: { cookie } });
const npj = (await np.json()) as Record<string, unknown>;
console.log(`nowplaying card: state=${npj.state} connected=${npj.connected} track=${String((npj.track as any)?.name ?? "—")}`);
const cardTrack = String((npj.track as any)?.name ?? "");

// A) The exact 04:18 failure message.
const a = await probe("A mention", {
  sender: "v374probe-a",
  prompt: "Venüs - Ben Senden Vazgeçtim (Official Video)",
});
const reply = String(a.reply ?? "");
const conflatesVenus = /ven[üu]s[^\n.]{0,60}dinliyoruz/i.test(reply) || /dinliyoruz[^\n.]{0,60}ven[üu]s/i.test(reply);
check("A1 no conflation: reply never says 'Venüs dinliyoruz'", !conflatesVenus, reply.slice(0, 120));
const mentionsCard = cardTrack && cardTrack !== "—" ? reply.toLowerCase().includes(cardTrack.toLowerCase().split(" ")[0]) : true;
const framesAsMention = /(yazd[ıi][g?][ıi]n|bahis|öner|payla[şs]t[ıi][g?][ıi]n|çalan (bu|şu|de[ğg]il)|çal[ıi]yor (ama|ancak))|farkl[ıi] bir par[çc]a|Epica/i.test(reply);
check("A2 separation: names the real card track or frames the paste as a mention", mentionsCard || framesAsMention, reply.slice(0, 120));

// B) Control — the deterministic lane still owns direct "what's playing" asks.
const b = await probe("B control", { sender: "v374probe-b", prompt: "şu an ne çalıyor" });
check(
  "B1 plak lane intact: route=cortex-nowplaying, zero model",
  String(b.route) === "cortex-nowplaying" && String(b.modelId) === "tool:now-playing",
  `route=${b.route} engine=${b.modelId}`,
);

console.log(`\n${fails === 0 ? "=== ALL PASS ===" : `=== ${fails} FAIL ===`}`);
process.exit(fails === 0 ? 0 : 1);
