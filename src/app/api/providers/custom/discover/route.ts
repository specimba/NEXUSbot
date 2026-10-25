import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import {
  discoverCustomModels,
  isCustomProtocol,
  isPlausibleProviderKey,
  isValidCustomBaseUrl,
  normalizeCustomBaseUrl,
  resolveCustomProvider,
} from "@/lib/connectors/custom-provider";

/**
 * POST /api/providers/custom/discover — BATCH model discovery (task C1).
 *
 * The panel backend proxies GET {base}[/v1]/models against an owner-supplied
 * OpenAI- or Anthropic-compatible gateway so the browser never makes
 * cross-origin calls to arbitrary hosts. Key resolution order:
 *   1. `apiKey` in the body (typed into the dialog — validated, used once,
 *      NEVER echoed back or stored here),
 *   2. the stored vault key when `providerId` is given (edit flow — key stays
 *      masked client-side),
 *   3. no key (some gateways expose /models publicly; the verdict says so).
 *
 * P7: responses carry model ids + static verdict strings only — key material
 * never appears anywhere.
 */

function err(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  if (!rateLimit(`custom-providers-discover:${clientKey(req)}`, 20, 60_000)) {
    return err("RATE_LIMITED", "Too many discover calls — slow down.", 429);
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const providerId = typeof body?.providerId === "string" && body.providerId.length > 0 ? body.providerId : null;

  // Defaults from the stored row (edit flow), overridable per-request (add flow).
  let protocol = isCustomProtocol(body?.protocol) ? body.protocol : null;
  let baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
  let key: string | null = null;

  if (providerId) {
    const row = await resolveCustomProvider(providerId);
    if (!row) return err("NOT_FOUND", "Provider not found.", 404);
    if (!protocol) protocol = row.protocol;
    if (!baseUrl) baseUrl = row.baseUrl;
    if (row.key) key = row.key; // transient — decrypted for this request only
  }

  if (!protocol) return err("BAD_PROTOCOL", "protocol must be \"openai\" or \"anthropic\".", 400);
  if (!baseUrl || !isValidCustomBaseUrl(baseUrl)) {
    return err("BAD_BASE_URL", "baseUrl must be a valid https:// URL without credentials.", 400);
  }

  const explicitKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (explicitKey.length > 0) {
    if (!isPlausibleProviderKey(explicitKey)) {
      return err("BAD_KEY", "apiKey must be 8–4096 characters when provided.", 400);
    }
    key = explicitKey;
  }

  const result = await discoverCustomModels({ baseUrl: normalizeCustomBaseUrl(baseUrl), protocol, key });
  if (!result.ok) {
    // Upstream verdicts surface honestly with their codes; 502 = bad gateway.
    return err(result.code, result.detail, 502);
  }

  return NextResponse.json({
    ok: true,
    models: result.models,
    count: result.models.length,
    truncated: result.truncated,
    keyUsed: result.keyUsed,
  });
}
