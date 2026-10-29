import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { encryptSecret } from "@/lib/crypto";
import type { ObsLinkApi } from "@/lib/widgets/api";

/**
 * POST /api/widgets/[id]/obs-link — the STABLE OBS Browser Source link.
 *
 * Why this exists: the old flow minted a fresh ingest token on every click and
 * kept the URL only in React state, so every panel refresh produced a
 * DIFFERENT URL (and OBS went stale). Now the link lives in the panel DB —
 * the origin-independent part (`/api/widgets/<id>/stream?token=…`) is stored
 * AES-256-GCM-encrypted on the widget row, so the panel can re-display the
 * SAME URL after any refresh, and only the host part is ever re-anchored.
 *
 * Actions (body: { action, baseUrl? }):
 *   create | reset — revoke the previous token (if any), mint a new one,
 *                    persist the encrypted link. baseUrl optional (keep existing).
 *   set-base        — set/clear the host anchor. baseUrl null|"" → follow the
 *                    current origin; "http://localhost:3000" → frozen anchor
 *                    (OBS on the same machine as the panel = permanent link).
 *   revoke          — revoke the token and clear the link.
 *
 * No new network hop: same server, same port, same stream route as before.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

type Ctx = { params: Promise<{ id: string }> };

/** http(s)://host[:port] only — no path, no userinfo. Returns null to clear. */
function normalizeBaseUrl(raw: unknown): { value: string | null; error?: string } {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw !== "string") return { value: null, error: "baseUrl must be a string or null." };
  const s = raw.trim();
  if (s.length === 0) return { value: null };
  if (s.length > 200) return { value: null, error: "baseUrl too long (max 200 chars)." };
  if (!/^https?:\/\//i.test(s)) {
    return { value: null, error: "Base URL must start with http:// or https:// — e.g. http://localhost:3000" };
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return { value: null, error: "Base URL is not a valid URL." };
  }
  if (!parsed.hostname) return { value: null, error: "Base URL has no host." };
  if (parsed.username || parsed.password) {
    return { value: null, error: "Base URL must not contain credentials." };
  }
  // Origin only (scheme://host[:port]) — the path always comes from the link.
  return { value: parsed.origin };
}

export async function POST(req: Request, ctx: Ctx) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`obs-link:${clientKey(req)}`, 20, 60_000)) {
    return err("RATE_LIMITED", "Too many link operations — slow down.", 429);
  }

  const { id } = await ctx.params;
  const widget = await db.widget.findUnique({ where: { id } });
  if (!widget) return err("NOT_FOUND", "Widget not found.", 404);

  const body = (await req.json().catch(() => null)) as { action?: unknown; baseUrl?: unknown } | null;
  const action = String(body?.action ?? "");

  /* ------------------------------------------------------------------ */
  /* create / reset — mint a fresh token, revoke the previous one        */
  /* ------------------------------------------------------------------ */
  if (action === "create" || action === "reset") {
    if (widget.obsTokenId) {
      await db.ingestToken
        .update({ where: { id: widget.obsTokenId }, data: { revokedAt: new Date() } })
        .catch(() => undefined); // token row may already be gone — not fatal
    }

    const token = `nxi_${randomBytes(24).toString("base64url")}`;
    const created = await db.ingestToken.create({
      data: {
        label: `obs-${widget.name}`.slice(0, 48),
        tokenHash: createHash("sha256").update(token).digest("hex"),
        preview: `${token.slice(0, 8)}…`,
      },
    });

    const path = `/api/widgets/${id}/stream?token=${encodeURIComponent(token)}`;
    const { cipher } = encryptSecret(path);

    let baseUrl = widget.obsBaseUrl ?? null;
    if (body?.baseUrl !== undefined) {
      const norm = normalizeBaseUrl(body.baseUrl);
      if (norm.error) return err("BAD_BASE_URL", norm.error, 400);
      baseUrl = norm.value;
    }

    await db.widget.update({
      where: { id },
      data: { obsTokenId: created.id, obsLinkCipher: cipher, obsBaseUrl: baseUrl },
    });

    const obsLink: ObsLinkApi = { path, baseUrl };
    return NextResponse.json({ ok: true, action: "create", obsLink });
  }

  /* ------------------------------------------------------------------ */
  /* set-base — freeze or clear the host anchor                          */
  /* ------------------------------------------------------------------ */
  if (action === "set-base") {
    if (!widget.obsLinkCipher) {
      return err("NO_LINK", "Create the OBS link first, then anchor it.", 400);
    }
    if (body?.baseUrl === undefined) {
      return err("BAD_BASE_URL", "baseUrl is required (null or \"\" to follow the current address).", 400);
    }
    const norm = normalizeBaseUrl(body.baseUrl);
    if (norm.error) return err("BAD_BASE_URL", norm.error, 400);

    await db.widget.update({ where: { id }, data: { obsBaseUrl: norm.value } });
    return NextResponse.json({ ok: true, action: "set-base", obsLink: { path: "", baseUrl: norm.value } });
  }

  /* ------------------------------------------------------------------ */
  /* revoke — kill the token, clear the link                             */
  /* ------------------------------------------------------------------ */
  if (action === "revoke") {
    if (widget.obsTokenId) {
      await db.ingestToken
        .update({ where: { id: widget.obsTokenId }, data: { revokedAt: new Date() } })
        .catch(() => undefined);
    }
    await db.widget.update({
      where: { id },
      data: { obsTokenId: null, obsLinkCipher: null, obsBaseUrl: null },
    });
    return NextResponse.json({ ok: true, action: "revoke", obsLink: null });
  }

  return err("BAD_ACTION", 'action must be "create", "reset", "set-base" or "revoke".', 400);
}
