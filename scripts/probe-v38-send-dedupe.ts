// probe-v38-send-dedupe.ts — v38 double-reply fix verification.
//
// Part A — sendLadderAdvance truth table: ONLY definitive rejections
//          (4xx shapes that PROVE "not posted") may advance the identity
//          ladder; ambiguous failures (408/429/5xx, 2xx) must STOP it.
// Part B — send-side idempotency: 60s exact-content window, TTL expiry,
//          per-content keying, FIFO cap eviction — all with an injected
//          clock, so the probe is deterministic and sends NOTHING to Kick.
//
// Zero live footprint: this process owns its own module runtime (the send
// map is per-process); no OAuth load, no HTTP, no DB writes.
import {
  sendLadderAdvance,
  kickSendDedupeCheck,
  kickSendDedupeRecord,
} from "../src/lib/connectors/kick";

let fails = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

console.log("== A) sendLadderAdvance truth table ==");
const ADVANCE = [400, 401, 403, 404, 422]; // definitive rejections → next shape allowed
const STOP = [200, 201, 204, 408, 409, 429, 500, 502, 503, 504]; // ambiguous/success → no re-post
for (const s of ADVANCE) check(`advance allowed on ${s}`, sendLadderAdvance(s) === true);
for (const s of STOP) check(`ladder STOPPED on ${s}`, sendLadderAdvance(s) === false);
// The exact historical shapes the ladder was built for keep advancing:
check("bot-not-approved 404 advances", sendLadderAdvance(404) === true);
check("validation 422 advances", sendLadderAdvance(422) === true);
// The exact incident classes must NOT advance:
check("gateway 502 stops (incident class)", sendLadderAdvance(502) === false);
check("timeout-ish 408 stops", sendLadderAdvance(408) === false);
check("rate-limit 429 stops", sendLadderAdvance(429) === false);

console.log("== B) send-side dedupe (injected clock) ==");
const T0 = 1_800_000_000_000; // fixed epoch — deterministic
const line = "Buradayım, silinmedim. Refresh at, ben buradayım.";
check("fresh map: no duplicate", kickSendDedupeCheck(line, T0) === false);
kickSendDedupeRecord(line, T0);
check("same line +1s → duplicate", kickSendDedupeCheck(line, T0 + 1_000) === true);
check("same line +59.999s → duplicate", kickSendDedupeCheck(line, T0 + 59_999) === true);
check("same line +60s → window over", kickSendDedupeCheck(line, T0 + 60_000) === false);
check("same line +600s → window over", kickSendDedupeCheck(line, T0 + 600_000) === false);
const other = "Tamam, tek cevap: Çatlı 2.";
check("different line → not a duplicate", kickSendDedupeCheck(other, T0 + 2_000) === false);
kickSendDedupeRecord(other, T0 + 2_000);
check("both lines tracked independently", kickSendDedupeCheck(line, T0 + 3_000) === true && kickSendDedupeCheck(other, T0 + 3_000) === true);
check("older line expires while newer lives", kickSendDedupeCheck(line, T0 + 61_000) === false && kickSendDedupeCheck(other, T0 + 61_000) === true);
// Whitespace differences are distinct keys at this layer — the LADDER records
// the normalized text (collapse/strip/trim happen before hashing in
// kickSendBotMessage), so the transport contract here is exact-normalized-text.
const ws = "Buradayım,  silinmedim. Refresh at, ben buradayım.";
check("un-normalized variant is a different key (hash layer is exact)", kickSendDedupeCheck(ws, T0 + 4_000) === false);

console.log("== C) FIFO cap eviction ==");
const base = 2_000_000_000_000;
const first = "cap-first-line";
kickSendDedupeRecord(first, base);
for (let i = 0; i < 80; i++) kickSendDedupeRecord(`cap-line-${i}`, base + i); // push past the 64 cap
check("oldest entry evicted at cap", kickSendDedupeCheck(first, base + 100) === false);
check("newest entry still deduped", kickSendDedupeCheck("cap-line-79", base + 100) === true);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
