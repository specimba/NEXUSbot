/**
 * NEXUS OS v37.3 — mail-cadence one-shot run (spawned by mini-services/mail-cadence).
 *
 * Two jobs, both AgentMail-lane, both idempotent:
 *   1. COMMAND POLL (every run): pull-based mail→bot command lane — triple-gated
 *      (owner sender allowlist · Agent Armor verdict "clear" · strict subject
 *      whitelist). Cursor semantics live in the connector lib; a re-run without
 *      new mail is a no-op.
 *   2. DAILY DIGEST (once per Istanbul day, 05:00–12:00 window): yesterday's
 *      chat/LLM/durability stats emailed to the owner (specimba@gmail.com).
 *      Dedupe = Setting agentmail.digest.lastDate — a panel-triggered digest
 *      never claims the day, so the cron still sends its own.
 *
 * Runs from the project root: `bun run scripts/mail-cadence.ts [--digest-only|--commands-only]`
 * Honest output only — failures print the error and exit non-zero; no secrets
 * ever appear in output (P7).
 */
import {
  loadAgentMailKey,
  pollAgentMailCommands,
  sendDailyDigest,
  istanbulDay,
  AGENTMAIL_OWNER_EMAIL,
} from "../src/lib/connectors/agentmail";
import { db } from "../src/lib/db";

const DIGEST_LAST_DATE_KEY = "agentmail.digest.lastDate";
const DIGEST_WINDOW_HOURS: [number, number] = [5, 12]; // Istanbul local hour

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const digestOnly = args.has("--digest-only");
  const commandsOnly = args.has("--commands-only");

  const loaded = await loadAgentMailKey();
  if (!loaded.ok) {
    console.log("MAIL-CADENCE SKIP: AgentMail key not in vault (import credentials first)");
    return;
  }

  // --- 1) command poll -------------------------------------------------------
  if (!digestOnly) {
    const poll = await pollAgentMailCommands(loaded.key, {});
    if (!poll.ok) {
      console.log(`MAIL-CADENCE COMMANDS FAILED: ${poll.error}`);
    } else {
      const { scanned, processed, skipped } = poll.data;
      if (processed.length === 0) {
        console.log(
          `COMMANDS OK: scanned ${scanned}, nothing to run (skipped: not-owner ${skipped.notOwner}, armor-not-clear ${skipped.armorNotClear}, no-command ${skipped.noCommand}, old ${skipped.old}, pending ${skipped.pending})`,
        );
      } else {
        for (const p of processed) {
          const status = p.replySent ? "replied" : `REPLY FAILED: ${p.replyError ?? "?"}`;
          console.log(`COMMAND EXECUTED: "${p.command}" (subject "${p.subject}") → ${p.replySubject} [${status}]`);
        }
      }
    }
  }

  // --- 2) daily digest (once per Istanbul day, morning window) ----------------
  if (!commandsOnly) {
    const today = istanbulDay();
    const istHour = new Date(Date.now() + 3 * 60 * 60 * 1000).getUTCHours();
    const [winStart, winEnd] = DIGEST_WINDOW_HOURS;
    const lastRow = await db.setting.findUnique({ where: { key: DIGEST_LAST_DATE_KEY } });
    const alreadyToday = lastRow?.value === today.label;

    if (alreadyToday) {
      console.log(`DIGEST SKIP: already sent for ${today.label}`);
    } else if (istHour < winStart || istHour >= winEnd) {
      console.log(
        `DIGEST SKIP: outside the ${winStart}:00–${winEnd}:00 Istanbul window (now ${istHour}:00) — will send on the first morning run`,
      );
    } else {
      const sent = await sendDailyDigest(loaded.key);
      if (!sent.ok) {
        console.log(`DIGEST FAILED: ${sent.error}`);
      } else {
        await db.setting.upsert({
          where: { key: DIGEST_LAST_DATE_KEY },
          create: { key: DIGEST_LAST_DATE_KEY, value: today.label },
          update: { value: today.label },
        });
        console.log(
          `DIGEST OK: ${sent.data.digest.dateLabel} → ${AGENTMAIL_OWNER_EMAIL} (interactions ${sent.data.digest.interactions.total}, message ${sent.data.sent.messageId.slice(0, 12)}…)`,
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("MAIL-CADENCE ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
