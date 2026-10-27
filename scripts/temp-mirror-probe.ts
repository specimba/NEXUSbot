/** Temp Task-25 forensics 2: value shapes + live mirror RPC probe. */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const widget = await db.widget.findFirst({ where: { seeded: true } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
  const url = vars.find((v) => v.name === "supabase_url")?.value?.trim() ?? "";
  const anon = vars.find((v) => v.name === "supabase_anon_key")?.value?.trim() ?? "";
  console.log(`supabase_url = ${url.slice(0, 46)}${url.length > 46 ? "…" : ""} (len ${url.length})`);
  console.log(`anon prefix  = ${anon.slice(0, 14)}… (len ${anon.length}, starts eyJ: ${anon.startsWith("eyJ")})`);

  const root = url.replace(/\/functions\/v1\/.*$/i, "").replace(/\/+$/, "");
  console.log(`normalized root = ${root}`);
  if (/^https:\/\/.+/.test(root) && (anon.startsWith("eyJ") || anon.startsWith("sb_"))) {
    try {
      const res = await fetch(`${root}/rest/v1/rpc/nexus_mirror_push`, {
        method: "POST",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_kind: "interactions", p_rows: [] }),
        signal: AbortSignal.timeout(8000),
      });
      const text = (await res.text()).slice(0, 200);
      console.log(`no-op RPC probe: HTTP ${res.status} body=${text}`);
    } catch (e) {
      console.log(`no-op RPC probe threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log("creds shape rejected — no probe");
  }

  const ms = await db.setting.findUnique({ where: { key: "brain.mirror.status" } });
  if (ms?.value) {
    const s = JSON.parse(ms.value) as Record<string, unknown>;
    console.log(
      `mirror.status: ok=${s.ok} configured=${s.configured} pushed=${s.pushed} failed=${s.failed} probedAt=${s.probedAt}`,
    );
    console.log(`  probeNote=${String(s.probeNote).slice(0, 140)}`);
    console.log(`  lastError=${String(s.lastError).slice(0, 140)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
