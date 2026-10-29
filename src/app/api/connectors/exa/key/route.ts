import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { EXA_LABEL, EXA_SERVICE, loadExaKey } from "@/lib/connectors/exa";

/**
 * v29.13 — Exa API key management (vault-backed). Session-guarded.
 *
 * PUT    { apiKey }            → AES-256-GCM vault upsert (service "exa", label "default").
 * DELETE                       → removes the stored credential.
 * POST   { action: "push-edge" } → pushes EXA_API_KEY to the live Supabase edge
 *                                project (vwottesqbdgcsmvvvzok) via the Management
 *                                API so the stream chat brain can use Exa.
 *                                Wire format is the one MEASURED in
 *                                scripts/deploy-edge-cortex.ts: POST
 *                                /v1/projects/{ref}/secrets with [{"name","value"}].
 *
 * P7: neither the Exa key nor the Supabase PAT is ever echoed, logged, or
 * stored in .env. Only a masked preview (last 4 chars) is returned.
 */

const SUPABASE_PROJECT_REF = "vwottesqbdgcsmvvvzok";
const SUPABASE_MGMT_BASE = "https://api.supabase.com";

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 });
}

function upstreamFailure(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 502 });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

  if (apiKey.length < 8 || apiKey.length > 4096) {
    return badRequest("BAD_API_KEY", "apiKey must be 8–4096 characters");
  }

  const { keyId, cipher } = encryptSecret(apiKey);

  const saved = await db.credential.upsert({
    where: { service_label: { service: EXA_SERVICE, label: EXA_LABEL } },
    create: { service: EXA_SERVICE, label: EXA_LABEL, keyId, cipher },
    update: { keyId, cipher },
  });

  return NextResponse.json({
    ok: true,
    credential: {
      id: saved.id,
      service: saved.service,
      label: saved.label,
      keyId: saved.keyId,
      masked: maskSecret(apiKey),
    },
  });
}

export async function DELETE() {
  const denied = await requireSession();
  if (denied) return denied;

  const removed = await db.credential.deleteMany({
    where: { service: EXA_SERVICE, label: EXA_LABEL },
  });

  // Idempotent: removing an absent credential is still a success.
  return NextResponse.json({ ok: true, removed: removed.count });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  if (action !== "push-edge") {
    return badRequest("BAD_ACTION", 'action must be "push-edge"');
  }

  // 1) Exa key from the vault.
  const exa = await loadExaKey();
  if (!exa.ok) {
    return badRequest("EXA_KEY_MISSING", "Store the Exa key first");
  }

  // 2) Supabase Management PAT from the vault (service "supabase", label "mgmt").
  const patRow = await db.credential.findUnique({
    where: { service_label: { service: "supabase", label: "mgmt" } },
  });
  if (!patRow) {
    return badRequest("MGMT_PAT_MISSING", "Supabase management PAT not stored (Connectors → Supabase)");
  }
  let pat: string;
  try {
    pat = decryptSecret(patRow.cipher);
  } catch {
    return badRequest(
      "MGMT_PAT_MISSING",
      "Supabase management PAT is unreadable (vault key rotated out?) — re-save it in Connectors → Supabase",
    );
  }

  // 3) Push EXA_API_KEY via the Management API — measured wire format
  //    (scripts/deploy-edge-cortex.ts): [{"name","value"}], 15s timeout.
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_MGMT_BASE}/v1/projects/${SUPABASE_PROJECT_REF}/secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ name: "EXA_API_KEY", value: exa.key }]),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return upstreamFailure("PUSH_FAILED", "Management API did not respond within 15s");
    }
    return upstreamFailure("PUSH_FAILED", "network error reaching the Supabase Management API");
  }

  if (!res.ok) {
    // Never echo the response body — only the honest status code (P7).
    return upstreamFailure("PUSH_FAILED", `Management API HTTP ${res.status}`);
  }

  return NextResponse.json({
    ok: true,
    pushed: true,
    secretName: "EXA_API_KEY",
    note: "Secrets apply to new edge invocations immediately — no redeploy needed",
  });
}
