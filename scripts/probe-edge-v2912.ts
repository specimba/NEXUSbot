/**
 * v29.12 verification probe — one real chat call against BOTH deployed edge
 * functions, measuring wall latency and inspecting the new telemetry fields
 * (failReason, vyceBreaker, providerAttempts). Read-only otherwise.
 * Run: bun scripts/probe-edge-v2912.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const REF = "vwottesqbdgcsmvvvzok";

async function main() {
  const widget = await db.widget.findFirst({ where: { seeded: true }, select: { variables: true } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
  const anon = vars.find((v) => v.name === "supabase_anon_key")?.value ?? "";
  if (!anon) throw new Error("supabase_anon_key missing from widget variables");

  for (const slug of ["nexus-cortex", "nexus-cortex-harness"]) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://${REF}.supabase.co/functions/v1/${slug}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${anon}`,
          apikey: anon,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "chat",
          sender: "nexusv2912probe",
          streamerName: "specimba",
          prompt: "tek cümlelik kisa bir selam ver",
          preferredModel: "auto",
        }),
        signal: AbortSignal.timeout(20000),
      });
      const ms = Date.now() - t0;
      const j = await res.json().catch(() => ({}));
      const t = (j as Record<string, any>)?.telemetry ?? {};
      console.log(
        JSON.stringify(
          {
            slug,
            http: res.status,
            wallMs: ms,
            ok: (j as Record<string, any>)?.ok,
            modelLabel: (j as Record<string, any>)?.modelLabel,
            replyPreview: String((j as Record<string, any>)?.reply ?? "").slice(0, 60),
            edgeLatencyMs: t.latencyMs,
            webSearch: t.webSearch,
            vyceBreaker: t.vyceBreaker,
            failReason: t.failReason,
            attempts: Array.isArray(t.providerAttempts)
              ? t.providerAttempts.map((a: any) => `${a.provider}/${a.model}/${a.status ?? a.errorName}/${a.elapsedMs}ms`)
              : undefined,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.log(JSON.stringify({ slug, wallMs: Date.now() - t0, error: String(err) }));
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
