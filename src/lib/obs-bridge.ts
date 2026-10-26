/**
 * NEXUS OS — stable OBS bridge constants (task 26-d).
 *
 * The panel lives at a rotating preview address; OBS Browser Sources need one
 * URL that never changes. The bridge is a static page (public/obs.html) that
 * rides the sanitized GitHub snapshot chain (specimba/NEXUSbot main) and is
 * served by GitHub Pages — it reads the panel's CURRENT origin from
 * obs-target.json (raw.githubusercontent.com) and redirects the OBS browser to
 * the live widget stream. This module holds the shared constants so the
 * panel UI and the publish route cannot drift.
 *
 * Client-safe: no Node-only imports in this file.
 */

export const OBS_BRIDGE_REPO = "specimba/NEXUSbot";

/**
 * GitHub Pages host of the bridge page. CORRECTED 2026-10-26: the old value
 * was `https://specimba.github.io/specimba/NEXUSbot/obs.html` — the owner
 * name was DOUBLE-pATHED (the github.io subdomain already carries it), so
 * every URL the Widgets card displayed hit GitHub's "There isn't a GitHub
 * Pages site here" 404 page EVEN AFTER Pages was enabled. The real Pages URL
 * shape is https://<owner>.github.io/<repo>/… — verified live (HTTP 200).
 */
export const OBS_BRIDGE_PAGE = `https://specimba.github.io/NEXUSbot/obs.html`;

/** Live origin file (raw GitHub: CORS *, ~5-min cache) the bridge page reads. */
export const OBS_TARGET_RAW_URL = `https://raw.githubusercontent.com/${OBS_BRIDGE_REPO}/main/obs-target.json`;

/** Full OBS-stable URL for a widget's ingest token. */
export function buildObsBridgeUrl(widgetId: string, token: string): string {
  return `${OBS_BRIDGE_PAGE}?t=${encodeURIComponent(token)}&w=${encodeURIComponent(widgetId)}`;
}

/**
 * Extract { widgetId, token } from a stored OBS link path
 * ("/api/widgets/<id>/stream?token=<tok>"). Returns null when the path is not
 * the exact stream shape — callers then hide the bridge block instead of
 * guessing.
 */
export function parseObsLinkPath(path: string): { widgetId: string; token: string } | null {
  try {
    const u = new URL(path, "https://nexus.invalid");
    const m = u.pathname.match(/^\/api\/widgets\/([^/]+)\/stream$/);
    const token = u.searchParams.get("token") ?? "";
    if (!m || !/^[a-z0-9]{16,}$/i.test(m[1]) || !/^[A-Za-z0-9_-]{16,}$/.test(token)) {
      return null;
    }
    return { widgetId: m[1], token };
  } catch {
    return null;
  }
}
