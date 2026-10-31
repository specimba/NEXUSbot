// v389-e2e-seq — sequence E2E on a FRESH channel: the authority row lands in
// the ring FIRST, then a fragment research demand must NOT weld it (the
// disconnect-guide re-leak path measured in the first E2E run).
const env = await Bun.file(".env").text();
const pass = env.match(/^PANEL_PASSWORD=(.*)$/m)?.[1]?.trim();
const login = await fetch("http://localhost:3000/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: pass }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const CH = "v389seq" + Math.random().toString(36).slice(2, 8);

async function send(sender: string, prompt: string) {
  const r = await fetch("http://localhost:3000/api/brain/cortex", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ sender, prompt, channel: CH }),
  });
  return (await r.json()) as Record<string, unknown>;
}

const a = await send("v389seqa", "EXA nın bağlantısını kes.");
console.log(`1) authority: route=${a.route} :: "${String(a.reply ?? "").slice(0, 120)}"`);
if (String(a.route) !== "cortex-authority") { console.log("FAIL step1"); process.exit(1); }

// let the ring settle, then the fragment demand
await new Promise((r) => setTimeout(r, 1500));
const b = await send("v389seqb", "lan exa ile arasana");
console.log(`2) fragment: route=${b.route} engine=${b.modelId}`);
console.log(`   reply: "${String(b.reply ?? "").slice(0, 280)}"`);
const INFRA_RE = /mcp|claude|cursor|ba[ğg]lant[ıi].{0,30}(kes|kapat|sonland[ıi]r)|devre d[ıi][şs][ıi] b[ıi]rak/i;
const leaked = INFRA_RE.test(String(b.reply ?? ""));
console.log(leaked ? "\nFAIL — disconnect guide re-leaked through the ring" : "\nPASS — no disconnect-guide leak through the ring");
process.exit(leaked ? 1 : 0);
