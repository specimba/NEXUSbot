// v388-e2e-edge — direct EDGE-lane verification of the deployed v38.8 persona
// (zero Kick sends; calls the remote Supabase function exactly like
// edgeChatAttempt does). The 05:35-05:52 +03 babble rows were ALL this lane
// (gpt-oss-120b via edge); the panel-lane races in v388-e2e.ts were won by
// beam-1.0, so the edge persona itself must be probed head-on.
import { db } from "../src/lib/db";

const SIMILE_RE =
  /(çorap|çay\s*bard|çay\s*fincan|uzay\s*gem|uzay\s*istasyon|wi[\s-]?fi|patlayan\s*balon|çöpçatan|kahve\s*fincan)[^.,!?]{0,40}(gibi|kadar)|((gibi|kadar)[^.,!?]{0,12}(çorap|çay\s*bard|uzay\s*gem|wi[\s-]?fi))/i;

async function main() {
  const widget = await db.widget.findFirst({ where: { name: "Specimba Cyber AI Counter" } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name?: string; value?: string }>;
  const get = (n: string) => String(vars.find((v) => v.name === n)?.value ?? "").trim();
  const anon = get("supabase_anon_key");
  let edgeUrl = get("supabase_edge_url");
  if (!edgeUrl) {
    const sb = get("supabase_url").replace(/\/+$/, "");
    edgeUrl = sb.includes("/functions/v1/") ? sb : `${sb}/functions/v1/nexus-cortex`;
  }
  console.log(`edgeUrl: ${edgeUrl.slice(0, 60)}… anon: ${anon ? "present" : "MISSING"}`);

  let fails = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fails++;
  };

  async function edgeChat(prompt: string): Promise<{ reply: string; label: string; model?: string }> {
    const res = await fetch(edgeUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${anon}`,
        apikey: anon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "chat",
        sender: "v388edgeprobe",
        streamerName: "specimba",
        prompt,
        preferredModel: "auto",
        roomTranscript: "",
        dialogue: [],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = (await res.json()) as Record<string, unknown>;
    return {
      reply: String(j.reply ?? ""),
      label: String(j.label ?? j.model ?? "?"),
      model: String(j.modelId ?? ""),
    };
  }

  // The measured babble rows, verbatim:
  const cases: Array<[string, string]> = [
    ["B trash-opinion", "uncharted çöp bir oyun"],
    ["C stories-agree", "hikayeleri cok iyi degil mi"],
    ["lag-sock-row", "vyce bağlantısında lag var sesin kesik kesik geliyor"],
  ];
  for (const [label, prompt] of cases) {
    const r = await edgeChat(prompt);
    console.log(`\n${label} [${r.label}${r.model ? " / " + r.model : ""}]:`);
    console.log(`  "${r.reply.slice(0, 300)}"`);
    check(`${label} no simile soup`, !SIMILE_RE.test(r.reply), "free of the measured simile class");
    check(`${label} non-empty`, r.reply.trim().length > 10, `len=${r.reply.length}`);
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : `FAILURES: ${fails}`}`);
  await db.$disconnect();
  if (fails > 0) process.exit(1);
}

main().catch((e) => {
  console.error("EDGE PROBE FAIL", e);
  process.exit(1);
});
