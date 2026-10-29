import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { cacheSealPassphrase } from "@/lib/seal-cache";
import { createSeal, readSealMeta, SEAL_PATH } from "@/lib/seal";

/**
 * GET  /api/backup/seal — honest seal state (meta only; NO secret material).
 * POST /api/backup/seal — create/refresh the encrypted sandbox seal
 *                         (body: { passphrase }). The passphrase never leaves
 *                         this process; the seal file is AES-256-GCM under
 *                         scrypt(passphrase) and is GIT-TRACKED so the GitHub
 *                         snapshot chain carries it through any sandbox reset.
 */
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const state = readSealMeta();
  return NextResponse.json({
    ok: true,
    path: SEAL_PATH,
    exists: state.exists,
    meta: state.meta,
    error: state.error,
  });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  // Rate-limited because scrypt N=2^15 is CPU-costly, not for brute-force.
  if (!rateLimit(`seal:${clientKey(req)}`, 6, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many seal attempts — wait a minute." } },
      { status: 429 },
    );
  }

  const body = (await req.json().catch(() => null)) as { passphrase?: unknown } | null;
  const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
  if (passphrase.length < 12) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_PASSPHRASE", message: "Passphrase must be at least 12 characters — this file rides in the public snapshot, its strength IS the passphrase." } },
      { status: 400 },
    );
  }

  try {
    const meta = await createSeal(passphrase);
    // Prime the in-process auto-reseal cache: a verified re-seal must keep the
    // seal tracking live vault state from now on, exactly like a successful
    // unseal does (cache is memory-only, never logged/returned — P7).
    cacheSealPassphrase(passphrase);
    return NextResponse.json({ ok: true, meta });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: { code: "SEAL_FAILED", message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}
