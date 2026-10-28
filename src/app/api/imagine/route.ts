/**
 * POST /api/imagine — the FREE last-resort image lane for the stream bot's
 * imagine flow (Task 31-b, v31.0).
 *
 * Lane order inside the widget: Supabase edge fn → vyce.ai direct (both PAID,
 * ~$0.50/viewer credit) → THIS route. It only fires when the paid lanes died
 * (the 2026-10-27 vyce HTTP 502 class left viewers with a deducted credit and
 * NO image — the worst possible outcome). Because the viewer's credit was
 * already spent upstream, this lane must never ALSO bill anyone: it runs the
 * in-house z-ai SDK, which costs nothing. SERVER-SIDE ONLY — the SDK never
 * ships to the client, no viewer device, no OBS, no CORS.
 *
 * Auth mirrors the brain surface exactly (src/lib/brain/auth.ts): the OBS
 * widget calls same-origin with the ingest token header `x-nexus-token`; a
 * valid panel session cookie is equally accepted. Rate limits are three deep
 * (per-sender / per-IP / global) because a FREE lane is an abuse magnet —
 * the paid lanes had a credit cost as their natural brake, this one only has
 * these guards.
 *
 * Body:  { sender?: string, prompt: string, size?: string }
 * Reply: { ok: true, imageUrl: "data:image/png;base64,…", modelLabel,
 *          provider: "zai", size }
 */
import { NextResponse } from "next/server";
import { hasBrainAccess } from "@/lib/brain/auth";
import { clientKey, rateLimit } from "@/lib/guard";
import ZAI from "z-ai-web-dev-sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The only sizes the free engine accepts — mirrored from the SDK's own type.
 * Unknown widget values coerce to the square default (never an error: the
 * widget sends a small fixed set, so anything else is a bug, not viewer fault). */
const IMAGINE_SIZES = [
  "1024x1024",
  "768x1344",
  "864x1152",
  "1344x768",
  "1152x864",
  "1440x720",
  "720x1440",
] as const;

type ImagineSize = (typeof IMAGINE_SIZES)[number];

function isImagineSize(value: string): value is ImagineSize {
  return (IMAGINE_SIZES as readonly string[]).includes(value);
}

/** Every non-POST verb gets the same honest 405 — this route is a lane the
 * widget POSTs to, nothing else. */
function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } },
    { status: 405 },
  );
}

export async function GET(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function HEAD(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function PUT(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function PATCH(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function OPTIONS(): Promise<NextResponse> {
  return methodNotAllowed();
}

export async function POST(req: Request) {
  try {
    // ── 1) Auth — same gate as every brain route (ingest token or session). ──
    if (!(await hasBrainAccess(req))) {
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Brain access denied" } },
        { status: 401 },
      );
    }

    // ── 2) Body ─────────────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_INPUT", message: "Body must be JSON" } },
        { status: 400 },
      );
    }

    // sender: trim → clamp 60 → default to the channel's neutral viewer name.
    const sender =
      (typeof body.sender === "string" ? body.sender : "").trim().slice(0, 60) || "izleyici";

    // prompt: trim → min 2 chars → clamp 900 → strip ALL control chars
    // (\x00-\x1F removed outright — they never reach the engine).
    const promptTrimmed = (typeof body.prompt === "string" ? body.prompt : "").trim();
    if (promptTrimmed.length < 2) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "BAD_PROMPT", message: "Prompt is missing or too short (min 2 chars)." },
        },
        { status: 400 },
      );
    }
    const prompt = promptTrimmed.slice(0, 900).replace(/[\u0000-\u001f]/g, "");
    if (!prompt) {
      // Control-char-only payloads must not slip through to the engine.
      return NextResponse.json(
        {
          ok: false,
          error: { code: "BAD_PROMPT", message: "Prompt is missing or too short (min 2 chars)." },
        },
        { status: 400 },
      );
    }

    const rawSize = (typeof body.size === "string" ? body.size : "").trim();
    const size: ImagineSize = isImagineSize(rawSize) ? rawSize : "1024x1024";

    // ── 3) Rate limits — tightest first (free lane ⇒ three-deep guard). ────
    if (!rateLimit(`imagine:${sender}`, 4, 300_000)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Personal imagine limit reached — try again in a few minutes.",
          },
        },
        { status: 429 },
      );
    }
    if (!rateLimit(`imagine-ip:${clientKey(req)}`, 10, 300_000)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Too many imagine requests from your network — cool down a moment.",
          },
        },
        { status: 429 },
      );
    }
    if (!rateLimit(`imagine-global`, 14, 300_000)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Imagine queue is saturated right now — try again shortly.",
          },
        },
        { status: 429 },
      );
    }

    // ── 4) Free engine (z-ai SDK, server-side only). ────────────────────────
    // globalThis lesson (v29.19): Next dev (Turbopack) instantiates SEPARATE
    // module instances per route compilation — only a process-wide global
    // survives, so the (credential-holding) SDK client is created once.
    const g = globalThis as typeof globalThis & {
      __nexusZAI?: Awaited<ReturnType<typeof ZAI.create>>;
    };
    const zai = (g.__nexusZAI ??= await ZAI.create());

    // Hard 80s wall: a hung generation must not pin an OBS browser source —
    // the widget gets a fast honest 504 instead of a frozen overlay.
    // v35.1 — wall raised 45s → 80s: live-measured z-ai image generation ran
    // 52.7s on 2026-10-29, so the old 45s wall would have killed every real
    // generation (the outage-night lesson: timeouts must fit MEASURED
    // generation times, not guessed ones).
    // v31.1 — bounded 429 backoff: the z-ai remote fn throttles in short
    // bursts (measured 05:2x +03: two instant 429s while the reader lane
    // recovered minutes later). Two retries (3s / 8s backoff) ride out the
    // burst; everything else fails fast and honestly.
    const isThrottle = (e: unknown) => /429|too many requests/i.test(e instanceof Error ? e.message : "");
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    let timedOut = false;
    // Each attempt owns its timer: a fast 429 failure must not leave a stale
    // 45s bomb ticking under the retry (unhandled rejection + a false
    // timedOut flip mid-retry).
    const attempt = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          zai.images.generations.create({ prompt, size }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("imagine engine timeout"));
            }, 80_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      let resp: Awaited<ReturnType<typeof attempt>>;
      try {
        resp = await attempt();
      } catch (first) {
        if (timedOut || !isThrottle(first)) throw first;
        await sleep(3_000);
        try {
          resp = await attempt();
        } catch (second) {
          if (timedOut || !isThrottle(second)) throw second;
          await sleep(8_000);
          resp = await attempt();
        }
      }
      const b64 = resp?.data?.[0]?.base64;
      if (!b64) {
        return NextResponse.json(
          {
            ok: false,
            error: { code: "ZAI_UNAVAILABLE", message: "Free image engine did not return an image." },
          },
          { status: 502 },
        );
      }
      return NextResponse.json(
        {
          ok: true,
          imageUrl: `data:image/png;base64,${b64}`,
          modelLabel: "NEXUS // Z-IMAGINE",
          provider: "zai",
          size,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      if (timedOut) {
        return NextResponse.json(
          { ok: false, error: { code: "ZAI_TIMEOUT", message: "Free image engine timed out." } },
          { status: 504 },
        );
      }
      throw e;
    } finally {
      // timers are owned and cleared per-attempt (see attempt()); nothing
      // to clean here anymore.
    }
  } catch (e) {
    // Last-resort net: short safe text only — no stack, no secrets.
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "IMAGINE_FAILED",
          message: `Imagine failed: ${e instanceof Error ? e.message.slice(0, 160) : "unknown error"}`,
        },
      },
      { status: 500 },
    );
  }
}
