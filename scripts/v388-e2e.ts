// v388-e2e — LIVE panel-lane verification of the simile-ban + why-banter
// guard (zero Kick sends; panel cortex API only, probe sender). Reproduces
// the measured 05:35-05:52 +03 babble rows end-to-end:
//   A) "@Robotic_Darkelf_Jedi neden hep boş yapıyor…" → must route CHAT
//      (pre-fix: RESEARCH with fabricated viewer psychology), and the reply
//      must carry NO invented simile ("gibi" skeleton from unrelated objects).
//   B) "uncharted çöp bir oyun" → CHAT reply, no simile soup.
//   C) "hikayeleri cok iyi degil mi" → CHAT reply, no simile soup.
//   D) simile detector runs on every reply: flags "X gibi/ kadar" where X is
//      an unrelated concrete object (çorap/çay/uzay/Wi-Fi/gem­i class).
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

async function probe(label: string, prompt: string) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sender: "v388p" + Math.random().toString(36).slice(2, 8), prompt, channel: "specimba" }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  const ms = Date.now() - t0;
  console.log(`\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} ${ms}ms`);
  console.log(`  reply: "${String(j.reply ?? "").slice(0, 300)}"`);
  return { j, ms };
}

// Simile-soup detector: "gibi/kadar" chained to the measured unrelated-object
// class (the sock/tea/spaceship/Wi-Fi imagery the owner flagged).
const SIMILE_RE =
  /(çorap|çay\s*bard|çay\s*fincan|uzay\s*gem|uzay\s*istasyon|wi[\s-]?fi|patlayan\s*balon|labirent\s*gibi\s*çöp|çöpçatan|kahve\s*fincan)[^.,!?]{0,40}(gibi|kadar)|((gibi|kadar)[^.,!?]{0,12}(çorap|çay\s*bard|uzay\s*gem|wi[\s-]?fi))/i;
function hasSimileSoup(reply: string): boolean {
  return SIMILE_RE.test(reply);
}

// A) the measured berxx misroute row — router fix
const a = await probe(
  "A why-banter (measured berxx row)",
  "@Robotic_Darkelf_Jedi neden hep boş yapıyor kötü dediysek kötü uncharted oynucana gitsin gta oynasın",
);
check("A routes CHAT", a.j.route === "cortex-chat" || /chat/i.test(String(a.j.route ?? "")), `route=${a.j.route}`);
check("A no simile soup", !hasSimileSoup(String(a.j.reply ?? "")), "reply free of invented similes");

// B+C) the babble rows — persona fix (route was always CHAT)
const b = await probe("B trash-opinion", "uncharted çöp bir oyun");
check("B routes CHAT", /chat/i.test(String(b.j.route ?? "")), `route=${b.j.route}`);
check("B no simile soup", !hasSimileSoup(String(b.j.reply ?? "")), "reply free of invented similes");

const c = await probe("C stories-agree", "hikayeleri cok iyi degil mi");
check("C routes CHAT", /chat/i.test(String(c.j.route ?? "")), `route=${c.j.route}`);
check("C no simile soup", !hasSimileSoup(String(c.j.reply ?? "")), "reply free of invented similes");

// D) research lane sanity — the erlik lock must still answer grounded
const d = await probe("D research-lock sanity", "erlik kimdir");
check(
  "D research intact",
  /research/i.test(String(d.j.route ?? "")) && String(d.j.reply ?? "").length > 40,
  `route=${d.j.route} len=${String(d.j.reply ?? "").length}`,
);

console.log(`\n${fails === 0 ? "ALL PASS" : `FAILURES: ${fails}`}`);
if (fails > 0) process.exit(1);
