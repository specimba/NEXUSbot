// probe-v375-trivial-gate.ts — live verification of the 1-char deterministic
// gate (v37.5). Panel test lane ONLY; zero Kick footprint.
// A) "a" (the exact burst message) → cortex-trivial, zero model, canned reply.
// B) "?" (1-char question mark) → also caught, canned variant.
// C) "sa kanka" (2-char slang + word) → NOT trivial (reaches the model ladder).
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

async function probe(label: string, sender: string, prompt: string) {
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sender, prompt }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  console.log(`\n${label}: status=${r.status} route=${j.route} engine=${j.modelId} label=${j.modelLabel}`);
  console.log(`  reply: "${String(j.reply ?? "")}"`);
  return j;
}

const a = await probe("A trivial", "v375probe-a", "a");
check("A1 'a' → route=cortex-trivial, zero model", String(a.route) === "cortex-trivial" && String(a.modelId) === "tool:trivial-guard", `route=${a.route} engine=${a.modelId}`);
check("A2 canned honest reply, no emoji", /Tek harf|Bir harf|kartonda/i.test(String(a.reply)) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(String(a.reply)), String(a.reply).slice(0, 80));

const b = await probe("B trivial ? (determinism check)", "v375probe-b", "?");
check("B1 '?' → also deterministic trivial", String(b.route) === "cortex-trivial", `route=${b.route}`);

const c = await probe("C control 2-char slang", "v375probe-c", "sa kanka");
check("C1 'sa kanka' NOT trivial — reaches the model ladder", String(c.route) !== "cortex-trivial", `route=${c.route} engine=${c.modelId}`);

console.log(`\n${fails === 0 ? "=== ALL PASS ===" : `=== ${fails} FAIL ===`}`);
process.exit(fails === 0 ? 0 : 1);
