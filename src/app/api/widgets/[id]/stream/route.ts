import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { buildWidgetDocument } from "@/lib/widgets/runtime";

/**
 * GET /api/widgets/[id]/stream?token=<ingest-token> — the widget as a live HTML
 * page for the OBS Browser Source URL. No "Local file" dance, no re-export
 * after every save: the URL always serves the SAVED state, so "Save → refresh
 * the source in OBS" is the whole workflow.
 *
 * Auth: OBS cannot carry the panel session cookie, so the URL embeds an ingest
 * token (?token=…), created explicitly from the panel (Widgets → OBS Browser
 * Source). The token is a credential — it renders the widget with its baked
 * variables — revocable like any ingest token, and a fresh one can be created
 * at any time. A valid panel session may also load the URL (preview/testing).
 */
function htmlPage(status: number, body: string) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
      `<style>body{margin:0;padding:16px;font:12px/1.6 monospace;background:#05080c;color:#f1f5f9}</style>` +
      `</head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!rateLimit(`widget-stream:${clientKey(req)}`, 240, 60_000)) {
    return htmlPage(
      429,
      `<p style="color:#ff0055">NEXUS widget stream: rate limited — the OBS source refreshes too fast. Wait a moment and refresh again.</p>`,
    );
  }

  const url = new URL(req.url);
  const presented =
    (url.searchParams.get("token") ?? "").trim() ||
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  if (presented) {
    const hash = createHash("sha256").update(presented).digest("hex");
    const token = await db.ingestToken.findUnique({ where: { tokenHash: hash } });
    if (!token || token.revokedAt) {
      return htmlPage(
        401,
        `<p style="color:#ff0055">NEXUS widget stream: invalid or revoked token. Create a fresh OBS token in the panel (Widgets → OBS Browser Source URL).</p>`,
      );
    }
    await db.ingestToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
  } else {
    const denied = await requireSession();
    if (denied) return denied;
  }

  const { id } = await ctx.params;
  const widget = await db.widget.findUnique({ where: { id } });
  if (!widget) {
    return htmlPage(404, `<p style="color:#ff0055">NEXUS widget stream: widget not found.</p>`);
  }
  if (!widget.enabled) {
    return htmlPage(
      200,
      `<p style="color:#ff0055">NEXUS widget "${widget.name.replace(/[<>&]/g, "")}" is DISABLED in the panel — enable it there and refresh this source.</p>`,
    );
  }

  const doc = buildWidgetDocument({
    id: widget.id,
    name: widget.name,
    width: widget.width,
    height: widget.height,
    html: widget.html,
    css: widget.css,
    js: widget.js,
    variables: widget.variables,
  });

  return new NextResponse(doc, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
