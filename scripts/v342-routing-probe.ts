// v342-routing-probe.ts — live probes for the v34.2 guards via /api/brain/cortex.
// Costs: one cheap beam chat race + one ~$0.005 exa answer. No chat posts
// (cortex route never posts to Kick). Rows are NOT written by this route.
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
if (!pass) throw new Error("PANEL_PASSWORD missing");
const base = "http://localhost:3000";

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
console.log("login:", login.status);

async function probe(label: string, body: Record<string, unknown>) {
  const r = await fetch(`${base}/api/brain/cortex`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as Record<string, unknown>;
  console.log(
    `${label}: status=${r.status} route=${j.route} engine=${j.modelId} reply="${String(j.reply ?? "").slice(0, 60)}"`,
  );
  return j;
}

// 1. Meta question WITH the widget's research hint → must demote to CHAT
const p1 = await probe("meta+hint", {
  sender: "cronprobe",
  prompt: "peki nasıl test edersin",
  isResearchHint: true,
});
// 2. Bot's own sender → must self-skip (no generation)
const p2 = await probe("bot-self", {
  sender: "NEXUSspecimbaBOT",
  prompt: "1 kez yaz",
});
// 3. Genuine research (kimdir) → must still route to research
const p3 = await probe("research", {
  sender: "cronprobe",
  prompt: "Mustafa Kemal Atatürk kimdir kisaca",
});

const ok =
  p1.route === "cortex-chat" &&
  p2.route === "cortex-self" &&
  p3.route === "cortex-research";
console.log(ok ? "\nALL ROUTING PROBES PASS" : "\nPROBE MISMATCH — see above");
process.exit(ok ? 0 : 1);
