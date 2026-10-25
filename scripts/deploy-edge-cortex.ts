/**
 * Deploy edge/nexus-cortex/index.ts to BOTH Supabase edge functions
 * (nexus-cortex + nexus-cortex-harness) via the Management API, and upsert the
 * search-budget secrets first so the new code boots with them.
 * Run: bun scripts/deploy-edge-cortex.ts
 *
 * [MEASURED 2026-10-25] Working wire format (HTTP 201, version++):
 *   POST /v1/projects/{ref}/functions/deploy?slug={slug}&verify_jwt=true
 *   multipart parts:
 *     - "metadata": JSON file part  {"entrypoint_path":"index.ts","verify_jwt":true}
 *     - "file": binary file part, filename = "index.ts" (the FILENAME maps the
 *       bundle path; the part NAME must be exactly "file" — parts named after
 *       the path produce "Entrypoint path does not exist").
 *   Secrets: POST /v1/projects/{ref}/secrets expects [{"name": ..., "value": ...}]
 *   (NOT "key" — that answers 400 "expected string, received undefined").
 *
 * Secrets set here (project-scoped edge secrets):
 *   NEXUS_SEARCH_GLOBAL_MAX_PER_HOUR = 12  (all viewers combined, per hour)
 *   NEXUS_SEARCH_USER_MAX_PER_HOUR   = 2   (per chat sender, per hour)
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const REF = "vwottesqbdgcsmvvvzok";
const SLUGS = ["nexus-cortex", "nexus-cortex-harness"];
const MGMT = "https://api.supabase.com";
const SOURCE = path.join(process.cwd(), "edge", "nexus-cortex", "index.ts");

const SECRETS = [
  { name: "NEXUS_SEARCH_GLOBAL_MAX_PER_HOUR", value: "12" },
  { name: "NEXUS_SEARCH_USER_MAX_PER_HOUR", value: "2" },
];

async function main() {
  const row = await db.credential.findUnique({
    where: { service_label: { service: "supabase", label: "mgmt" } },
  });
  if (!row) throw new Error("supabase mgmt PAT not stored in vault");
  const { decryptSecret } = await import("../src/lib/crypto");
  const pat = decryptSecret(row.cipher);
  const auth = { Authorization: `Bearer ${pat}` };

  // 1) upsert secrets (name/value shape — see measured note above)
  const secRes = await fetch(`${MGMT}/v1/projects/${REF}/secrets`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(SECRETS),
    signal: AbortSignal.timeout(15000),
  });
  console.log(`secrets upsert: HTTP ${secRes.status} ${(await secRes.text()).slice(0, 200)}`);

  // 2) deploy source to each slug
  const source = fs.readFileSync(SOURCE, "utf8");
  for (const slug of SLUGS) {
    const fd = new FormData();
    fd.append(
      "metadata",
      new Blob([JSON.stringify({ entrypoint_path: "index.ts", verify_jwt: true })], {
        type: "application/json",
      }),
      "metadata.json",
    );
    fd.append("file", new Blob([source], { type: "text/plain" }), "index.ts");
    const res = await fetch(
      `${MGMT}/v1/projects/${REF}/functions/deploy?slug=${encodeURIComponent(slug)}&verify_jwt=true`,
      { method: "POST", headers: auth, body: fd, signal: AbortSignal.timeout(90000) },
    );
    const text = (await res.text()).slice(0, 400);
    console.log(`deploy ${slug}: HTTP ${res.status} ${text}`);
  }

  // 3) verify the live GET endpoint version on both slugs
  const widget = await db.widget.findFirst({ where: { seeded: true }, select: { variables: true } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
  const anon = vars.find((v) => v.name === "supabase_anon_key")?.value ?? "";
  for (const slug of SLUGS) {
    try {
      const res = await fetch(`https://${REF}.supabase.co/functions/v1/${slug}`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
        signal: AbortSignal.timeout(15000),
      });
      const body = (await res.json()) as { service?: string };
      console.log(`verify ${slug}: HTTP ${res.status} service=${body.service ?? "?"}`);
    } catch (e) {
      console.log(`verify ${slug}: FAILED ${e instanceof Error ? e.message : e}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
