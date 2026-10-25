/**
 * One-off ops probe: verify the deployed nexus-cortex edge function versions
 * (GET endpoint with the widget's anon key) and list the project's functions
 * via the Management API PAT (vault: service "supabase", label "mgmt").
 * Read-only. Run: bun scripts/edge-fn-probe.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const REF = "vwottesqbdgcsmvvvzok";

async function main() {
  // 1) widget anon key probe
  const widget = await db.widget.findFirst({ where: { seeded: true }, select: { variables: true } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
  const anon = vars.find((v) => v.name === "supabase_anon_key")?.value ?? "";
  for (const slug of ["nexus-cortex", "nexus-cortex-harness"]) {
    try {
      const res = await fetch(`https://${REF}.supabase.co/functions/v1/${slug}`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      console.log(`GET ${slug}: HTTP ${res.status} ${text.slice(0, 300)}`);
    } catch (e) {
      console.log(`GET ${slug}: FAILED ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2) Management API function list (PAT from vault)
  const row = await db.credential.findUnique({
    where: { service_label: { service: "supabase", label: "mgmt" } },
  });
  if (!row) {
    console.log("mgmt PAT: NOT STORED");
    return;
  }
  // Use the panel's own crypto module for envelope compatibility.
  const { decryptSecret } = await import("../src/lib/crypto");
  const pat = decryptSecret(row.cipher);
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, {
    headers: { Authorization: `Bearer ${pat}` },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  console.log(`MGMT list functions: HTTP ${res.status}`);
  try {
    const fns = JSON.parse(text) as Array<Record<string, unknown>>;
    for (const f of fns) {
      console.log(
        `  slug=${f.slug} status=${f.status} verify_jwt=${f.verify_jwt} updated=${f.updated_at ?? "?"} size=${f.size ?? "?"}`,
      );
    }
  } catch {
    console.log(text.slice(0, 400));
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
