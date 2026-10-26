import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth";

/**
 * Brain pipeline auth (v29.8).
 *
 * The OBS widget page is served from /api/widgets/[id]/stream?token=<ingest
 * token> — the runtime shim captures that token and forwards it as the
 * `x-nexus-token` header on every brain call (search / log / context / reset).
 * A valid panel session cookie is equally accepted so the panel preview and
 * the owner's tooling can call the same endpoints without a token.
 *
 * Revoking the ingest token in the panel instantly cuts the widget off from
 * the brain surface too — one credential, one kill switch.
 */
export async function hasBrainAccess(req: Request): Promise<boolean> {
  const presented = (req.headers.get("x-nexus-token") ?? "").trim();
  if (presented) {
    const hash = createHash("sha256").update(presented).digest("hex");
    const token = await db.ingestToken.findUnique({ where: { tokenHash: hash } });
    if (!token || token.revokedAt) return false;
    db.ingestToken
      .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return true;
  }
  const denied = await requireSession();
  return denied === null;
}

/** Channel roster — mirrored from the widget config (v29.7 dump). */
export const CHANNEL_ROSTER = {
  streamer: "specimba",
  mods: ["yavuzerdem99", "robotic_darkelf_jedi"] as readonly string[],
};

export function isRosterAdmin(handle: string): boolean {
  const lower = String(handle || "").toLowerCase();
  return lower === CHANNEL_ROSTER.streamer || CHANNEL_ROSTER.mods.includes(lower);
}

export function clampStr(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, max);
}

/** Neutralize anything that looks like a credential before storing/sharing. */
export function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/\b(?:gsk|sk|hb|nxs)_[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted-jwt]")
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_]{8,}\b/g, "[redacted-sb]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-hex]");
}

export const FLAG_SEVERITY: Record<string, number> = {
  COMMAND_ABUSE: 1,
  FLOOD_ABUSE: 1,
  SECRET_FISHING: 2,
  PROMPT_INJECTION: 2,
  RESET_ATTEMPT: 2,
  FAKE_AUTHORITY: 3,
};

export const VALID_FLAGS = new Set(Object.keys(FLAG_SEVERITY));
