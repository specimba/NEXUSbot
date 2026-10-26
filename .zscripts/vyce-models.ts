import { loadVyceKey, resolveVyceBaseUrl } from "@/lib/connectors/vyce";
async function main() {
  const { ok, key } = await loadVyceKey();
  if (!ok || !key) { console.log("NO KEY"); process.exit(1); }
  const base = await resolveVyceBaseUrl();
  const res = await fetch(base.replace(/\/+$/, "") + "/models", {
    headers: { authorization: "Bearer " + key },
    signal: AbortSignal.timeout(8000),
  });
  console.log("status:", res.status);
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j.data ?? []);
    const ids = arr.map((m: { id?: string }) => m.id).filter(Boolean);
    console.log("models:", JSON.stringify(ids));
  } catch {
    console.log("body head:", text.slice(0, 400));
  }
}
main();
