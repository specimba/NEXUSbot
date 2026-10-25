/* One-off diagnostic: verify widget supabase_url/anon_key REST probe (sanitized). */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const widget = await db.widget.findFirst({ where: { seeded: true }, select: { variables: true } });
const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
const url = (vars.find((v) => v.name === "supabase_url")?.value ?? "").trim();
const anon = (vars.find((v) => v.name === "supabase_anon_key")?.value ?? "").trim();
const root = url.replace(/\/functions\/v1\/.*$/i, "").replace(/\/+$/, "");
console.log("root host:", new URL(root).host, "anon looks like JWT:", anon.startsWith("eyJ"));

const res = await fetch(`${root}/rest/v1/`, {
  headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  signal: AbortSignal.timeout(8000),
});
const text = await res.text();
console.log("GET /rest/v1/ ->", res.status, "len", text.length, "head:", text.slice(0, 80).replace(anon, "[scrub]"));

// Does the RPC exist? (unauth probe would 401; with anon but empty rows we just
// read the OpenAPI paths list — check nexus_mirror_push is advertised)
const spec = (await (await fetch(`${root}/rest/v1/`, {
  headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  signal: AbortSignal.timeout(8000),
})).json()) as { paths?: Record<string, unknown> };
const paths = Object.keys(spec.paths ?? {}).filter((p) => p.includes("nexus_mirror"));
console.log("advertised mirror paths:", paths.join(", ") || "(none)");
await db.$disconnect();
