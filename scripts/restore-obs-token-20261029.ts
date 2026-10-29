/**
 * One-off surgical restore (2026-10-29 reset): the OBS ingest token handed to
 * the owner (~19:16 +03) was minted ~60s AFTER the last seal was written
 * (19:15:14 +03) and died in the sandbox wipe. The owner's OBS Browser Source
 * already carries that exact URL, so instead of forcing an OBS-side change we
 * reconstruct the IngestToken row from the token literal the owner supplied
 * (their chat message — the token is theirs, hash-only is stored, same scheme
 * as api/widgets/[id]/obs-link route.ts):
 *
 *   tokenHash = sha256(token).hex
 *   preview   = `${token.slice(0,8)}…`
 *   label     = `obs-${widget.name}`.slice(0,48)
 *   widget    → obsTokenId = new row, obsLinkCipher = AES(path), base kept
 *
 * The token literal is NEVER written into any tracked file (it would ride the
 * public snapshot): it arrives via the NEXUS_OBS_TOKEN env var at run time.
 *
 * Idempotent: re-running with the same token is a no-op (revokedAt cleared,
 * widget re-pointed). The previous token row (the seal-era nxi_0YpH… one) is
 * revoked, exactly like the panel's own "create" action does.
 *
 * Run: NEXUS_OBS_TOKEN='<token>' bun scripts/restore-obs-token-20261029.ts
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();

const WIDGET_ID = "cmvpgs4ef000fraue6ycyvmej";

async function main(): Promise<void> {
  const token = process.env.NEXUS_OBS_TOKEN ?? "";
  if (!/^nxi_[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("NEXUS_OBS_TOKEN env var missing or malformed (expected nxi_<base64url>)");
  }

  const widget = await db.widget.findUnique({ where: { id: WIDGET_ID } });
  if (!widget) throw new Error(`widget ${WIDGET_ID} not found`);

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const preview = `${token.slice(0, 8)}…`;

  // Idempotent create-or-reuse (never duplicate a hash row).
  let row = await db.ingestToken.findUnique({ where: { tokenHash } });
  if (row) {
    if (row.revokedAt) {
      row = await db.ingestToken.update({ where: { id: row.id }, data: { revokedAt: null } });
    }
  } else {
    row = await db.ingestToken.create({
      data: { label: `obs-${widget.name}`.slice(0, 48), tokenHash, preview },
    });
  }

  // Revoke the seal-era token the widget pointed at (same semantics as the
  // panel's obs-link "create" action: one live token per widget).
  const priorId = widget.obsTokenId;
  if (priorId && priorId !== row.id) {
    await db.ingestToken
      .update({ where: { id: priorId }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  // Same link shape the panel's obs-link route stores (origin-independent path,
  // AES-256-GCM via the vault envelope so the panel re-displays the same URL).
  const linkPath = `/api/widgets/${WIDGET_ID}/stream?token=${encodeURIComponent(token)}`;
  const { cipher } = encryptSecret(linkPath);

  await db.widget.update({
    where: { id: WIDGET_ID },
    data: {
      obsTokenId: row.id,
      obsLinkCipher: cipher,
      // obsBaseUrl deliberately untouched: it matches the current preview origin.
      updatedAt: new Date(),
    },
  });

  // P7: metadata only — the token literal and the cipher are never printed.
  console.log(`[obs-restore] widget ${WIDGET_ID} ("${widget.name}") → token row ${row.id}`);
  console.log(`[obs-restore] preview=${preview} label=${row.label} revokedAt=${row.revokedAt}`);
  console.log(`[obs-restore] prior token ${priorId ?? "none"} → revoked`);
  console.log(`[obs-restore] link path stored (${linkPath.length} chars, cipher sealed)`);
}

main()
  .then(() => process.exit(0))
  .catch((e: Error) => {
    console.error(`[obs-restore] FAILED: ${e.message}`);
    process.exit(1);
  });
