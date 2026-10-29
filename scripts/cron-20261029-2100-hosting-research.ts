// scripts/cron-20261029-2100-hosting-research.ts — cardless hosting deep-research.
// Owner context: Oracle Always Free signup BLOCKED by card verification (2026-10-29) →
// the question changed from "best free VM" to "best CARDLESS always-on foundation".
// Read-only research: web search only, no page writes, no external spend.
import ZAI from "z-ai-web-dev-sdk";

const QUERIES: [string, string][] = [
  ["hf-specs", "Hugging Face Spaces free CPU Basic hardware 2 vCPU 16GB RAM"],
  ["hf-sleep", "Hugging Face Spaces sleep after 48 hours inactivity free tier"],
  ["claw", "ClawCloud Run free $5 monthly credit GitHub account 180 days no credit card"],
  ["cardless-general", "free always-on hosting no credit card required 2026 container"],
  ["serv00", "serv00 free hosting no credit card FreeBSD resources limits"],
  ["koyeb", "Koyeb free tier credit card required signup"],
  ["render", "Render free web services 512MB spin down no credit card"],
  ["uptime", "UptimeRobot free plan 50 monitors ping interval"],
];

function trim(s: unknown, n = 220): string {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").slice(0, n);
}

async function main() {
  const zai = await ZAI.create();
  for (const [tag, q] of QUERIES) {
    console.log(`\n### ${tag} :: ${q}`);
    try {
      // @ts-expect-error - SDK functions API is not fully typed
      const res = (await zai.functions.invoke("web_search", { query: q, num: 5 })) as any[];
      for (const r of res ?? []) {
        console.log(`- ${trim(r.title, 110)} | ${r.url ?? r.link ?? ""}`);
        console.log(`  ${trim(r.snippet ?? r.content ?? r.description ?? "")}`);
      }
      if (!res?.length) console.log("  (no results)");
    } catch (e: any) {
      console.log(`  SEARCH_FAILED: ${e?.message ?? e}`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
