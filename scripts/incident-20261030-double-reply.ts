/**
 * NEXUS OS — incident record: 2026-10-30 live double-reply.
 *
 * Owner/viewer directive (chat, 2026-10-30 04:37 +03, reporter
 * Robotic_Darkelf_Jedi): "yukarda bir mesajima iki cevap atti, kayitlara
 * gecsin" — one !ai message drew TWO identical bot replies in live chat;
 * the reporter asked for it to go INTO THE RECORDS. This script writes the
 * permanent audit row (Event) — the fix itself lives in
 * src/lib/connectors/kick.ts (v38 send ladder + send-side dedupe) and is
 * documented in worklog.md + CHANGELOG.md.
 *
 * Idempotent: re-running inserts nothing (marker event checked first).
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const TYPE = "incident.double-reply";
const MARKER = "v38-send-ladder-fix";

async function main() {
  const existing = await db.event.findFirst({
    where: { type: TYPE, payload: { contains: MARKER } },
    select: { id: true, createdAt: true },
  });
  if (existing) {
    console.log(`[incident-record] already recorded (event ${existing.id} @ ${existing.createdAt.toISOString()}) — skip`);
    return;
  }

  const row = await db.event.create({
    data: {
      source: "kick",
      type: TYPE,
      level: "warn",
      actor: "robotic_darkelf_jedi",
      payload: JSON.stringify({
        marker: MARKER,
        reportedAt: "2026-10-30T04:37:00+03:00",
        report: "yukarda bir mesajima iki cevap atti, kayitlara gecsin",
        symptom:
          "One viewer !ai message produced TWO identical bot replies in live Kick chat (NEXUSspecimbaBOT). The InteractionLog held ONE row per exchange — interactionRowDuplicate dedupes the second identical row, so the duplication was invisible in the panel log and happened at the transport.",
        rootCause:
          "kickSendBotMessage's identity ladder (bot -> bot+chatroom -> user) advanced to the next attempt on EVERY failure, including AMBIGUOUS ones (AbortSignal 15s timeout, socket errors, 5xx) where Kick may have ALREADY posted the first attempt. A slow-but-successful first POST followed by a client-side abort re-POSTed the same content -> duplicate line in chat.",
        fix: [
          "src/lib/connectors/kick.ts: sendLadderAdvance() — ladder only advances on definitive rejections (400/401/403/404/422 or 2xx is_sent:false); ambiguous failures (408/429/5xx, network, timeout) STOP the ladder — a missed reply is recoverable, a doubled one is not.",
          "src/lib/connectors/kick.ts: kickSendDedupeCheck/kickSendDedupeRecord — 60s exact-content send-side idempotency (sha256 key, FIFO 64 cap, check inside the serialized sendChain so racing callers can never both pass). Whatever path double-fires, the channel sees the line once.",
          "src/app/api/kick/webhook/route.ts: deduped sends logged (console.info) instead of silently passing.",
          "src/app/api/kick/test-chat/route.ts: honest deduped:true response for manual re-tests of identical content within the window.",
        ],
        verify: "scripts/probe-v38-send-dedupe.ts (ladder truth table + dedupe window/TTL/FIFO, deterministic injected clock)",
      }).slice(0, 8192),
    },
  });
  console.log(`[incident-record] Event ${row.id} written (${TYPE} / ${MARKER})`);
}

main()
  .catch((e) => {
    console.error("[incident-record] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
