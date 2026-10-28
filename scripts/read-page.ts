/**
 * Research helper: fetch a web page and strip it down to readable text.
 * Usage: bun scripts/read-page.ts <url> [max_chars]
 * Falls back to raw body when HTML parsing is not possible.
 */
async function main() {
  const url = process.argv[2];
  const maxChars = Number(process.argv[3] ?? 12000);
  if (!url || !/^https?:\/\//.test(url)) {
    console.error("Usage: bun scripts/read-page.ts <url> [max_chars]");
    process.exit(2);
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  let text = body;
  if (contentType.includes("html")) {
    text = body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
  }
  console.log(`URL: ${res.url}\nSTATUS: ${res.status}\nTYPE: ${contentType}\n---`);
  console.log(text.slice(0, maxChars));
}

main().catch((err: Error) => {
  console.error("READ_FAILED:", err.message);
  process.exit(1);
});
