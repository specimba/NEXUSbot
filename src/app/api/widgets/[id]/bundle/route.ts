import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import { buildWidgetDocument, parseWidgetVariables } from "@/lib/widgets/runtime";

/**
 * GET /api/widgets/[id]/bundle — the widget as ONE self-contained HTML file
 * (variables baked in at export time), served as a download.
 *
 * This is deliberately a DOWNLOAD, not a hosted widget URL: the owner saves
 * the file and adds it to OBS as a Local-file Browser Source. Local-first
 * (L0) — no public endpoint exists for widgets, nothing leaves the sandbox,
 * and OBS never needs the panel to be reachable.
 *
 * SECURITY NOTE surfaced in the panel UI too: the bundle embeds the CURRENT
 * variable VALUES, including secrets (Vyce/Groq/Supabase keys) — that is what
 * makes it work standalone on the owner's machine. Treat the exported file as
 * a credential: keep it local, re-export after rotating keys.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`widget-bundle:${clientKey(req)}`, 30, 60_000)) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests — slow down." } },
      { status: 429 },
    );
  }
  const { id } = await ctx.params;
  const widget = await db.widget.findUnique({ where: { id } });
  if (!widget) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Widget not found." } },
      { status: 404 },
    );
  }

  const doc = buildWidgetDocument(
    {
      id: widget.id,
      name: widget.name,
      width: widget.width,
      height: widget.height,
      html: widget.html,
      css: widget.css,
      js: widget.js,
      variables: widget.variables,
    },
    { bundle: true },
  );

  // Empty secret variables make the bundle work but its LLM paths will fail —
  // surface that honestly in a response header the panel can toast about.
  const vars = parseWidgetVariables(widget.variables);
  const emptySecrets = vars.filter((v) => v.secret && v.value.trim() === "").map((v) => v.name);

  const slug = widget.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "widget";
  return new NextResponse(doc, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="nexus-widget-${slug}.html"`,
      "Cache-Control": "no-store",
      ...(emptySecrets.length > 0 ? { "X-Nexus-Empty-Secrets": emptySecrets.join(",").slice(0, 400) } : {}),
    },
  });
}
