import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { countLore, deleteAllLore, deleteLore, listLore, upsertLore } from "@/lib/brain/lore";
import { ensureGroundingFresh } from "@/lib/brain/grounding";

export const dynamic = "force-dynamic";

/**
 * Lore Book CRUD (Phase G3, plan §5) — the owner's channel-wisdom store.
 *
 * Session-gated (owner-only surface). Entries live in the Setting KV
 * `brain.lore`, which the encrypted seal collects generically — lore
 * survives cold-boot restores with zero seal/schema work.
 *
 * GET    → { ok, entries, count, caps: { maxEntries, maxText, maxAliases } }
 * POST   → create  { aliases: string[], text: string, blockResearch?: boolean }
 * PUT    → update  { id, aliases?, text?, blockResearch? }
 * DELETE → ?id=<id> or ?all=1 (clear-all requires the explicit flag)
 */

const readLimiter = (req: Request) => rateLimit(`lore-read:${clientKey(req)}`, 120, 60_000);
const writeLimiter = (req: Request) => rateLimit(`lore-write:${clientKey(req)}`, 30, 60_000);

export async function GET(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!readLimiter(req)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }
  const entries = await listLore();
  return NextResponse.json(
    {
      ok: true,
      entries,
      count: entries.length,
      caps: { maxEntries: 40, maxText: 400, maxAliases: 6 },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!writeLimiter(req)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as
    | { aliases?: unknown; text?: unknown; blockResearch?: unknown }
    | null;
  if (!body) {
    return NextResponse.json({ ok: false, error: { code: "BAD_BODY", message: "JSON body required." } }, { status: 400 });
  }
  const res = await upsertLore({ aliases: body.aliases, text: body.text, blockResearch: body.blockResearch });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: { code: "BAD_LORE", message: res.error } }, { status: 400 });
  }
  ensureGroundingFresh();
  return NextResponse.json({ ok: true, entry: res.entry, count: await countLore() });
}

export async function PUT(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!writeLimiter(req)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as
    | { id?: unknown; aliases?: unknown; text?: unknown; blockResearch?: unknown }
    | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) {
    return NextResponse.json({ ok: false, error: { code: "BAD_ID", message: "`id` required for update." } }, { status: 400 });
  }
  const res = await upsertLore({
    id,
    aliases: body?.aliases,
    text: body?.text,
    blockResearch: body?.blockResearch,
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: { code: "BAD_LORE", message: res.error } }, { status: 400 });
  }
  ensureGroundingFresh();
  return NextResponse.json({ ok: true, entry: res.entry, count: await countLore() });
}

export async function DELETE(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!writeLimiter(req)) {
    return NextResponse.json({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down." } }, { status: 429 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("all") === "1") {
    const removed = await deleteAllLore();
    ensureGroundingFresh();
    return NextResponse.json({ ok: true, removed });
  }
  const id = url.searchParams.get("id") ?? "";
  if (!id) {
    return NextResponse.json({ ok: false, error: { code: "BAD_ID", message: "`?id=` or `?all=1` required." } }, { status: 400 });
  }
  const removed = await deleteLore(id);
  if (!removed) {
    return NextResponse.json({ ok: false, error: { code: "NOT_FOUND", message: "Lore entry not found." } }, { status: 404 });
  }
  ensureGroundingFresh();
  return NextResponse.json({ ok: true, removed: 1 });
}
