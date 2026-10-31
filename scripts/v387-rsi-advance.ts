// v387 — run the RSI cycle's pending MECHANICAL stage (pareto-gate: zero LLM
// calls, grades the completed paired runs). NOT the owner promote gate.
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!pass) throw new Error("PANEL_PASSWORD missing");
const base = "http://localhost:3000";
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (login.status !== 200) throw new Error(`login ${login.status}`);
const r = await fetch(`${base}/api/rsi/cycles/cmvvi96dj0043skt1ldf34qvj/advance`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({}),
});
const j = await r.json();
console.log("status:", r.status, JSON.stringify(j, null, 2).slice(0, 1400));
