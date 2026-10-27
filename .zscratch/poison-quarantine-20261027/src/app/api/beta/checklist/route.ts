import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { formatDistanceToNow } from "date-fns";
import { requireSession } from "@/lib/auth";
import { fetchKickTelemetry } from "@/lib/kick";
import { l0MirrorStatus } from "@/lib/l0-mirror";
import { getMgmtPat, mgmtListFunctions, mgmtListSecrets } from "@/lib/connectors/supabase";

/**
 * GET /api/beta/checklist (session required)
 *
 * R21-b beta-readiness for tonight's live KICK bot test: five MEASURED items —
 * cortex Edge Function deployed, edge secrets present, off-site L0 mirror,
 * kick.com channel telemetry, and the KickBot browser-side userVariables
 * contract (static guidance). Honesty rules:
 *  - no Mgmt PAT → "pending", never a guess;
 *  - upstream errors → warn/fail with the real HTTP status or code;
 *  - secret NAMES only in any output — values never leave the vault (P7).
 */

const CORTEX_PROJECT_REF = "vwottesqbdgcsmvvvzok";
const CORTEX_SLUG = "nexus-cortex";
/** Owner's legacy cortex EF source (in-sandbox) — grep'd at request time for
 * Deno.env.get("…") so the expected-secret list tracks the actual file. */
const CORTEX_EF_REL_PATH = "upload/extracted/kick/supabase_nexus_cortex_v30_index.ts";

/** Secrets Supabase injects into every Edge Function itself. If the Mgmt
 * secrets list lacks them that is normal, not a missing secret — surfaced as
 * a caveat in the detail, never silently dropped from the expected list. */
const SYSTEM_INJECTED = new Set([
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_URL",
]);

type BetaStatus = "ok" | "warn" | "fail" | "pending";

type BetaItem = {
  id: string;
  label: string;
  status: BetaStatus;
  detail: string;
  measured?: Record<string, unknown>;
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function expectedEdgeSecretNames(): Promise<{ names: string[]; error: string | null }> {
  try {
    const src = await readFile(path.join(process.cwd(), CORTEX_EF_REL_PATH), "utf8");
    const names = new Set<string>();
    for (const m of src.matchAll(/Deno\.env\.get\(\s*"([^"]+)"\s*\)/g)) {
      names.add(m[1].toUpperCase());
    }
    if (names.size === 0) {
      return { names: [], error: "cortex EF source contains no Deno.env.get reads — cannot derive the expected secret list" };
    }
    return { names: [...names].sort(), error: null };
  } catch {
    return { names: [], error: "cortex EF source not found in sandbox — cannot derive the expected secret list" };
  }
}

async function itemCortexDeployed(pat: string | null, pendingDetail: string): Promise<BetaItem> {
  const id = "ef-cortex-deployed";
  const label = "nexus-cortex Edge Function deployed";
  if (!pat) {
    return { id, label, status: "pending", detail: pendingDetail };
  }
  let res;
  try {
    res = await mgmtListFunctions(pat, CORTEX_PROJECT_REF);
  } catch (e) {
    return {
      id,
      label,
      status: "warn",
      detail: `Mgmt /functions → ${e instanceof Error ? e.message : "network error"} — cannot verify`,
    };
  }
  if (!res.ok) {
    return {
      id,
      label,
      status: "warn",
      detail: `Mgmt /functions → HTTP ${res.status || "network error"} — cannot verify`,
    };
  }
  const fns = res.functions;
  const found = fns.find(
    (f) => f.slug.toLowerCase() === CORTEX_SLUG || (f.name ?? "").toLowerCase() === CORTEX_SLUG,
  );
  if (!found) {
    return {
      id,
      label,
      status: "warn",
      detail: `not found among ${fns.length} deployed functions — deploy supabase_nexus_cortex_v30_index.ts`,
      measured: { deployedFunctions: fns.length },
    };
  }
  return {
    id,
    label,
    status: "ok",
    detail: `found in ${fns.length} functions, status ${found.status || "unknown"}`,
    measured: { deployedFunctions: fns.length, slug: found.slug, status: found.status },
  };
}

async function itemEdgeSecrets(pat: string | null, pendingDetail: string): Promise<BetaItem> {
  const id = "ef-secrets-present";
  const label = "Edge secrets for the cortex";
  if (!pat) {
    return { id, label, status: "pending", detail: pendingDetail };
  }

  const expected = await expectedEdgeSecretNames();
  if (expected.error) {
    return { id, label, status: "warn", detail: expected.error };
  }

  let res;
  try {
    res = await mgmtListSecrets(pat, CORTEX_PROJECT_REF);
  } catch (e) {
    return {
      id,
      label,
      status: "warn",
      detail: `Mgmt /secrets → ${e instanceof Error ? e.message : "network error"} — cannot verify`,
    };
  }
  if (!res.ok) {
    return {
      id,
      label,
      status: "warn",
      detail: `Mgmt /secrets → HTTP ${res.status || "network error"} — cannot verify`,
    };
  }

  // NAMES ONLY below — values never leave the vault (P7).
  const valuedNames = res.secrets.filter((s) => s.hasValue).map((s) => s.name);
  const present: string[] = [];
  const missing: string[] = [];
  for (const exp of expected.names) {
    const needle = exp.toLowerCase();
    const hit = valuedNames.some((name) => {
      const hay = name.toLowerCase();
      return hay.includes(needle) || needle.includes(hay);
    });
    (hit ? present : missing).push(exp);
  }

  if (missing.length === 0) {
    return {
      id,
      label,
      status: "ok",
      detail: `all ${present.length} cortex secrets have values`,
      measured: { expected: expected.names.length, present },
    };
  }
  const systemMissing = missing.filter((m) => SYSTEM_INJECTED.has(m));
  const caveat =
    systemMissing.length > 0
      ? ` — ${systemMissing.join(", ")} ${systemMissing.length === 1 ? "is" : "are"} Supabase system-injected (normal for them to be absent from the Mgmt list)`
      : "";
  return {
    id,
    label,
    status: "warn",
    detail: `missing ${missing.length}/${expected.names.length}: ${missing.join(", ")}${caveat}`,
    measured: { expected: expected.names.length, present, missing },
  };
}

async function itemMirror(): Promise<BetaItem> {
  const id = "db-mirror";
  const label = "Off-site L0 mirror (Postgres pooler)";
  let s;
  try {
    s = await l0MirrorStatus();
  } catch (e) {
    return {
      id,
      label,
      status: "fail",
      detail: `mirror status failed: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
  if (!s.configured) {
    return {
      id,
      label,
      status: "pending",
      detail: "paste supabase-db-url in the Supabase card (Connect button → Transaction pooler URI, port 6543)",
    };
  }
  if (!s.validate || !s.validate.ok) {
    return {
      id,
      label,
      status: "fail",
      detail: `pooler rejected: ${s.validate?.error ?? "no validate result"}`,
      measured: { masked: s.masked ?? undefined },
    };
  }

  const tables = s.migration?.tables ?? [];
  const need = ["rsi_config", "viewer_credits"];
  const missingTables = need.filter((t) => !tables.includes(t));

  if (missingTables.length === 0) {
    const lastPush = s.mirror.lastPushAt
      ? formatDistanceToNow(new Date(s.mirror.lastPushAt), { addSuffix: true })
      : "never";
    return {
      id,
      label,
      status: "ok",
      detail: `pooler live (${s.validate.serverVersion ?? "unknown"}) · ${tables.length} v30 tables · ${s.mirror.totalRows ?? "—"} mirror rows · last push ${lastPush}`,
      measured: {
        serverVersion: s.validate.serverVersion ?? null,
        nexusTables: tables.length,
        totalRows: s.mirror.totalRows,
        lastPushAt: s.mirror.lastPushAt,
      },
    };
  }
  if (s.migration && !s.migration.ok && s.migration.error) {
    return {
      id,
      label,
      status: "warn",
      detail: `connected but v30 table inventory failed: ${s.migration.error}`,
      measured: { nexusTables: tables.length },
    };
  }
  return {
    id,
    label,
    status: "warn",
    detail: `connected but v30 migration not applied (${tables.length} nexus tables) — press 'Apply v30 migration'`,
    measured: { nexusTables: tables.length, missingTables },
  };
}

async function itemKickTelemetry(): Promise<BetaItem> {
  const id = "kick-telemetry";
  const label = "KICK channel telemetry";
  const r = await fetchKickTelemetry("specimba");
  if (r.ok) {
    if (r.telemetry.isLive) {
      return {
        id,
        label,
        status: "ok",
        detail: `live: ${r.telemetry.viewers ?? "?"} viewers · ${truncate(r.telemetry.title ?? "untitled", 80)}`,
        measured: { isLive: true, viewers: r.telemetry.viewers },
      };
    }
    return { id, label, status: "ok", detail: "offline — channel reachable", measured: { isLive: false } };
  }
  return {
    id,
    label,
    status: r.code === "INVALID_CHANNEL" ? "fail" : "warn",
    detail: `${r.code} — ${r.message}`,
  };
}

function itemBotVariables(): BetaItem {
  return {
    id: "bot-variables",
    label: "KickBot userVariables (browser side)",
    status: "warn",
    detail:
      "ai_trigger=!ai · streamer_name=specimba · supabase_edge_url=https://vwottesqbdgcsmvvvzok.supabase.co/functions/v1/nexus-cortex · supabase_anon_key=(owner pastes the legacy eyJ… anon JWT from dashboard → Configuration → API Keys — NOT sb_publishable_; the cortex EF has verify_jwt=true and rejects sb_publishable_ tokens)",
    measured: {
      trigger: "!ai",
      streamer: "specimba",
      edgeUrl: "https://vwottesqbdgcsmvvvzok.supabase.co/functions/v1/nexus-cortex",
    },
  };
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  let pat: string | null = null;
  let vaultError: string | null = null;
  try {
    pat = await getMgmtPat();
  } catch (e) {
    vaultError = e instanceof Error ? e.message : "vault read failed";
  }
  const pendingDetail = vaultError
    ? `vault read failed (${vaultError}) — check the panel logs, then re-paste the PAT in the Supabase card`
    : "no Mgmt PAT in vault — paste it in the Supabase card";

  const [deployed, secrets, mirror, telemetry] = await Promise.all([
    itemCortexDeployed(pat, pendingDetail),
    itemEdgeSecrets(pat, pendingDetail),
    itemMirror(),
    itemKickTelemetry(),
  ]);

  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    items: [deployed, secrets, mirror, telemetry, itemBotVariables()],
  });
}
