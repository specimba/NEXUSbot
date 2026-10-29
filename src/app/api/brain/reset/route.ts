import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hasBrainAccess, clampStr, isRosterAdmin } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";

/**
 * POST /api/brain/reset — streamer/mod only "brain yeniden başlasın".
 *
 * Moves the memory cutoff forward: past dialogue stops feeding the context
 * ladder but every log row stays untouched (evaluation data is never deleted
 * by a chat command). The widget additionally wipes its local dossiers.
 */
export async function POST(req: Request) {
  if (!rateLimit(`brain-reset:${clientKey(req)}`, 10, 60_000)) {
    return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  }
  if (!(await hasBrainAccess(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { byUser?: unknown; channel?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json body" }, { status: 400 });
  }

  const byUser = clampStr(body.byUser, 60);
  if (!isRosterAdmin(byUser)) {
    return NextResponse.json(
      { ok: false, error: `@${byUser || "?"} için reset yetkisi yok` },
      { status: 403 },
    );
  }

  const channel = clampStr(body.channel, 40).toLowerCase() || "specimba";
  const key = `brain.memory.cutoff.${channel}`;
  const nowIso = new Date().toISOString();
  await db.setting.upsert({
    where: { key },
    create: { key, value: nowIso },
    update: { value: nowIso },
  });

  return NextResponse.json({ ok: true, channel, cutoff: nowIso, by: byUser.toLowerCase() });
}
