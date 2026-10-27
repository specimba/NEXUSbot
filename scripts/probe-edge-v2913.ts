/**
 * v29.13 verification probe — GET health check on BOTH deployed edge functions
 * (asserting the live version string) + ONE tiny real chat call against the
 * primary nexus-cortex slug, measuring wall latency and inspecting the v29.13
 * telemetry fields (webSearchProvider alongside failReason, vyceBreaker,
 * providerAttempts). Read-only otherwise; cost: one tiny chat message max.
 * Run: bun scripts/probe-edge-v2913.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const REF = "vwottesqbdgcsmvvvzok";
const EXPECTED_VERSION = "nexus-cortex-v29.13";

async function main() {
  const widget = await db.widget.findFirst({ where: { seeded: true }, select: { variables: true } });
  const vars = JSON.parse(widget?.variables ?? "[]") as Array<{ name: string; value: string }>;
  const anon = vars.find((v) => v.name === "supabase_anon_key")?.value ?? "";
  if (!anon) throw new Error("supabase_anon_key missing from widget variables");

  let failures = 0;

  // 1) GET health check both slugs — must report the deployed v29.13 version.
  for (const slug of ["nexus-cortex", "nexus-cortex-harness"]) {
    try {
      const res = await fetch(`https://${REF}.supabase.co/functions/v1/${slug}`, {
        headers: { apikey: anon, Authorization: `Bearer ${anon}` },
        signal: AbortSignal.timeout(15000),
      });
      const body = (await res.json()) as { service?: string };
      const ok = res.status === 200 && body.service === EXPECTED_VERSION;
      console.log(
        `GET ${slug}: HTTP ${res.status} service=${body.service ?? "?"} ${ok ? "OK" : `MISMATCH — expected ${EXPECTED_VERSION}`}`,
      );
      if (!ok) failures++;
    } catch (e) {
      console.log(`GET ${slug}: FAILED ${e instanceof Error ? e.message : e}`);
      failures++;
    }
  }

  // 2) ONE tiny real chat round-trip against the primary slug. A plain
  // greeting has no research intent, so the expected pre-Exa-key telemetry is
  // webSearch "none" + webSearchProvider "" (the field must simply EXIST).
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${REF}.supabase.co/functions/v1/nexus-cortex`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${anon}`,
        apikey: anon,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "chat",
        sender: "nexusv2913probe",
        streamerName: "specimba",
        prompt: "tek cümlelik kisa bir selam ver",
        preferredModel: "auto",
      }),
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - t0;
    const j = await res.json().catch(() => ({}));
    const t = (j as Record<string, any>)?.telemetry ?? {};
    const withinBudget = ms < 15000;
    const providerFieldPresent = t.webSearchProvider !== undefined;
    const breakerClosed = t.vyceBreaker === "closed";
    const failReasonEmpty = t.failReason === "";
    console.log(
      JSON.stringify(
        {
          slug: "nexus-cortex",
          http: res.status,
          wallMs: ms,
          within15sBudget: withinBudget,
          ok: (j as Record<string, any>)?.ok,
          modelLabel: (j as Record<string, any>)?.modelLabel,
          replyPreview: String((j as Record<string, any>)?.reply ?? "").slice(0, 60),
          edgeLatencyMs: t.latencyMs,
          webSearch: t.webSearch,
          webSearchProvider: t.webSearchProvider,
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
    if (!withinBudget) failures++;
    if (!providerFieldPresent) failures++;
    if (!breakerClosed) failures++;
    if (!failReasonEmpty) failures++;
  } catch (err) {
    console.log(JSON.stringify({ slug: "nexus-cortex", wallMs: Date.now() - t0, error: String(err) }));
    failures++;
  }

  console.log(
    failures === 0
      ? "PROBE PASS — nexus-cortex-v29.13 verified on both slugs, chat within budget, telemetry complete"
      : `PROBE FAIL — ${failures} check(s) failed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
