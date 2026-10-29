import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_PAYLOAD = 8 * 1024;

function clamp(v: string, n: number): string {
  return v.length > n ? v.slice(0, n) : v;
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);
  const source = url.searchParams.get("source");

  const events = await db.event.findMany({
    where: source ? { source } : undefined,
    orderBy: { ts: "desc" },
    take: limit,
  });

  return NextResponse.json({ ok: true, events });
}

/**
 * L0 ingest write path. Auth: panel session OR `Authorization: Bearer <ingest-token>`.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  let actor = "panel";

  if (bearer) {
    const token = await db.ingestToken.findUnique({ where: { tokenHash: sha256(bearer) } });
    if (!token || token.revokedAt) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_TOKEN", message: "Invalid ingest token" } },
        { status: 401 },
      );
    }
    await db.ingestToken.update({
      where: { id: token.id },
      data: { lastUsedAt: new Date() },
    });
    actor = `token:${token.label}`;
  } else {
    const denied = await requireSession();
    if (denied) return denied;
  }

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_BODY", message: "JSON body required" } },
      { status: 400 },
    );
  }

  const type = clamp(String(raw.type ?? "").trim(), 64);
  if (!type) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_TYPE", message: "`type` is required" } },
      { status: 400 },
    );
  }

  const source = clamp(String(raw.source ?? "system").trim(), 32) || "system";
  const levelRaw = String(raw.level ?? "info").trim();
  const level = LEVELS.has(levelRaw) ? levelRaw : "info";
  const eventActor = clamp(String(raw.actor ?? actor).trim(), 64) || actor;

  let payload = "{}";
  if (raw.payload !== undefined) {
    try {
      payload = JSON.stringify(raw.payload ?? {});
    } catch {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_PAYLOAD", message: "payload must be JSON-serializable" } },
        { status: 400 },
      );
    }
    if (payload.length > MAX_PAYLOAD) {
      return NextResponse.json(
        { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "payload exceeds 8 KiB" } },
        { status: 413 },
      );
    }
  }

  const event = await db.event.create({
    data: { source, type, level, actor: eventActor, payload },
  });

  return NextResponse.json({ ok: true, id: event.id }, { status: 201 });
}
