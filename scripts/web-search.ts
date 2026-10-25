/**
 * Research helper: web search via z-ai-web-dev-sdk (backend only).
 * Usage: bun scripts/web-search.ts "query" [num_results]
 */
import ZAI from "z-ai-web-dev-sdk";

async function main() {
  const query = process.argv[2];
  const num = Number(process.argv[3] ?? 8);
  if (!query) {
    console.error('Usage: bun scripts/web-search.ts "query" [num]');
    process.exit(2);
  }
  const zai = await ZAI.create();
  // @ts-expect-error - SDK functions API is not fully typed
  const result = await zai.functions.invoke("web_search", {
    query,
    num: Math.min(Math.max(num, 1), 20),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: Error) => {
  console.error("SEARCH_FAILED:", err.message);
  process.exit(1);
});
