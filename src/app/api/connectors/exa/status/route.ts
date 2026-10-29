import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import {
  EXA_CAPABILITIES,
  EXA_PROBE_TARGET,
  loadExaKey,
  probeExa,
  recordExaUsage,
  type ExaStatusPayload,
} from "@/lib/connectors/exa";

/**
 * v29.13 — Exa connector status. Session-guarded (requireSession).
 *
 * Response shape: { ok, status: { configured, reachable, apiOk, error, credential,
 * probedAt, probeTarget, capabilities, spend } }
 * - configured:false → no key in the vault (nothing probed).
 * - configured:true + vault-unreadable → honest error, nothing probed.
 * - configured:true → live probe (POST /search, keyword, 1 result, ~$0.004).
 *   A reachable host with a rejected key is NOT "connected" (zero theatre).
 * - spend → UsageEvent kind "exa" aggregate over the last 30 days (null on
 *   ledger error). Every fired probe is recorded via recordExaUsage.
 */

function respond(status: ExaStatusPayload) {
  return NextResponse.json({ ok: true, status });
}

async function exaSpend30d(): Promise<{ totalDollars30d: number; calls30d: number } | null> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const agg = await db.usageEvent.aggregate({
      where: { kind: "exa", ts: { gte: since } },
      _sum: { credits: true },
      _count: { _all: true },
    });
    return { totalDollars30d: agg._sum.credits ?? 0, calls30d: agg._count._all };
  } catch {
    return null;
  }
}

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const loaded = await loadExaKey();

  if (!loaded.ok && loaded.reason === "missing") {
    return respond({
      configured: false,
      reachable: null,
      apiOk: null,
      error: null,
      credential: null,
      probedAt: null,
      probeTarget: EXA_PROBE_TARGET,
      capabilities: [...EXA_CAPABILITIES],
      spend: await exaSpend30d(),
    });
  }

  if (!loaded.ok) {
    return respond({
      configured: true,
      reachable: null,
      apiOk: null,
      error: "Stored Exa key is unreadable (vault key rotated out?) — re-save the key.",
      credential: null,
      probedAt: null,
      probeTarget: EXA_PROBE_TARGET,
      capabilities: [...EXA_CAPABILITIES],
      spend: await exaSpend30d(),
    });
  }

  const probe = await probeExa(loaded.key);
  const probedAt = new Date().toISOString();
  const credential = { masked: loaded.masked, keyId: loaded.keyId, updatedAt: loaded.updatedAt };

  // Honest telemetry: every fired probe is a ledger row (cost 0 when rejected —
  // Exa does not bill 401/402/429 requests).
  recordExaUsage(
    "exa-search",
    probe.ok ? (probe.costDollars ?? 0.004) : 0,
    probe.tookMs,
    probe.ok,
    { probe: "status" },
  );

  if (probe.ok) {
    return respond({
      configured: true,
      reachable: true,
      apiOk: true,
      error: null,
      credential,
      probedAt,
      probeTarget: EXA_PROBE_TARGET,
      capabilities: [...EXA_CAPABILITIES],
      spend: await exaSpend30d(),
    });
  }

  const reachable = probe.kind !== "timeout" && probe.kind !== "network";
  return respond({
    configured: true,
    reachable,
    apiOk: false,
    error:
      probe.kind === "auth"
        ? `${probe.error} — save a valid key or disconnect.`
        : probe.error,
    credential,
    probedAt,
    probeTarget: EXA_PROBE_TARGET,
    capabilities: [...EXA_CAPABILITIES],
    spend: await exaSpend30d(),
  });
}
