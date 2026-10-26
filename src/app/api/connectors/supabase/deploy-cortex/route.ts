import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { requireSession } from "@/lib/auth";
import {
  getMgmtPat,
  mgmtUpsertSecrets,
  resolveCortexProjectRef,
  resolveCortexAnonKey,
} from "@/lib/connectors/supabase";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * POST /api/connectors/supabase/deploy-cortex (v29.14)
 *
 * One-click ship of edge/nexus-cortex/index.ts to BOTH live functions
 * (nexus-cortex + nexus-cortex-harness) — the exact wire format measured in
 * scripts/deploy-edge-cortex.ts (metadata JSON part + binary "file" part named
 * "file", filename index.ts), plus the budget secrets upsert first.
 *
 * WHY THIS EXISTS: the sandbox reset destroyed the vault key, so the previous
 * deploy path (local script + vault PAT) is gone until the owner re-enters a
 * Management PAT. With the PAT re-entered in Connectors, this route ships the
 * new cortex (hedged provider race + Exa research tier) without any CLI.
 *
 * Response includes a live GET probe of both functions (service version +
 * exaArmed) so the owner sees the truth, not optimism.
 */

const MGCT_BASE = "https://api.supabase.com";
const SECRETS = [
  { key: "NEXUS_SEARCH_GLOBAL_MAX_PER_HOUR", value: "12" },
  { key: "NEXUS_SEARCH_USER_MAX_PER_HOUR", value: "2" },
  { key: "NEXUS_EXA_SEARCH_MAX_PER_HOUR", value: "60" },
  { key: "NEXUS_EXA_ANSWER_MAX_PER_HOUR", value: "40" },
];
const SLUGS = ["nexus-cortex", "nexus-cortex-harness"] as const;

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`deploy-cortex:${clientKey(req)}`, 4, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }

  const pat = await getMgmtPat();
  if (!pat) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "NO_PAT",
          message:
            "No Supabase Management PAT in the vault. Add it in Connectors → Supabase first (dashboard → Account → Access Tokens).",
        },
      },
      { status: 409 },
    );
  }
  const ref = await resolveCortexProjectRef();
  if (!ref) {
    return NextResponse.json(
      { ok: false, error: { code: "NO_REF", message: "Widget supabase_url missing — cannot resolve project ref." } },
      { status: 409 },
    );
  }

  const sourcePath = path.join(process.cwd(), "edge", "nexus-cortex", "index.ts");
  if (!fs.existsSync(sourcePath)) {
    return NextResponse.json(
      { ok: false, error: { code: "NO_SOURCE", message: "edge/nexus-cortex/index.ts not found." } },
      { status: 500 },
    );
  }
  const source = fs.readFileSync(sourcePath, "utf8");

  // 1) Budget secrets (name/value wire shape — measured).
  let secretsStatus = 0;
  try {
    const res = await fetch(`${MGCT_BASE}/v1/projects/${ref}/secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify(SECRETS.map((s) => ({ name: s.key, value: s.value }))),
      signal: AbortSignal.timeout(20_000),
    });
    secretsStatus = res.status;
  } catch {
    secretsStatus = 0;
  }

  // 2) Deploy to both slugs.
  const deploys: Array<{ slug: string; status: number; detail: string }> = [];
  for (const slug of SLUGS) {
    try {
      const fd = new FormData();
      fd.append(
        "metadata",
        new Blob([JSON.stringify({ entrypoint_path: "index.ts", verify_jwt: true })], {
          type: "application/json",
        }),
        "metadata.json",
      );
      fd.append("file", new Blob([source], { type: "text/typescript" }), "index.ts");
      const res = await fetch(
        `${MGCT_BASE}/v1/projects/${ref}/functions/deploy?slug=${slug}&verify_jwt=true`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${pat}` },
          body: fd,
          signal: AbortSignal.timeout(60_000),
        },
      );
      const detail = (await res.text()).slice(0, 200);
      deploys.push({ slug, status: res.status, detail });
    } catch (e) {
      deploys.push({
        slug,
        status: 0,
        detail: e instanceof Error ? e.message.slice(0, 120) : "deploy failed",
      });
    }
  }

  // 3) Live probe both functions (anon Bearer).
  const anon = await resolveCortexAnonKey();
  const probes: Array<{ slug: string; status: number; service: string; exaArmed?: boolean }> = [];
  await new Promise((r) => setTimeout(r, 2500)); // allow the new container to boot
  for (const slug of SLUGS) {
    try {
      const res = await fetch(`https://${ref}.supabase.co/functions/v1/${slug}`, {
        headers: anon ? { Authorization: `Bearer ${anon}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json().catch(() => ({}))) as { service?: string; exaArmed?: boolean };
      probes.push({ slug, status: res.status, service: j.service ?? "", exaArmed: j.exaArmed });
    } catch (e) {
      probes.push({
        slug,
        status: 0,
        service: e instanceof Error ? e.message.slice(0, 80) : "probe failed",
      });
    }
  }

  const allOk = deploys.every((d) => d.status >= 200 && d.status < 300);
  return NextResponse.json({
    ok: allOk,
    secretsStatus,
    deploys,
    probes,
    note: "verify_jwt=true — the widget's 3-part anon JWT remains the auth (sb_publishable_ keys are rejected).",
  });
}
