/**
 * v37.3 — import owner-provided agent-system credentials into the vault.
 * Source: upload/AGENTMAILautomatedNEWagentSYSTEMSguide3010.txt (owner paste,
 * 2026-10-30). Plaintext keys live ONLY in the upload file (excluded from every
 * snapshot by the backup deny-list) and, after import, as AES-256-GCM
 * envelopes in the Credential table.
 *
 * SCRUB HISTORY (2026-10-30 ~03:40 +03): v37.1 embedded the five literal keys
 * here — the fail-closed secret scan correctly aborted every push from 02:33
 * on (the tinyfish key matches the openai-style `sk-…` pattern; the other four
 * would have shipped plaintext to the public repo had the scanner not been
 * pattern-lucky). This version carries ZERO literals: patterns are structural
 * (prefix + charset + length), and the values are extracted from the upload
 * file at runtime. Idempotent: upserts the same rows the 02:30 import wrote.
 */
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { encryptSecret } from "../src/lib/crypto";

const SOURCE = "upload/AGENTMAILautomatedNEWagentSYSTEMSguide3010.txt";

/** Structural extraction — prefix + charset + length, no literal values. */
function extractKeys(text: string, re: RegExp, expect: number): string[] {
  const found = [...new Set(text.match(re) ?? [])];
  if (found.length < expect) {
    throw new Error(`expected >=${expect} matches for ${re}, found ${found.length}`);
  }
  return found;
}

function main(): void {
  const paste = readFileSync(SOURCE, "utf8");

  // AgentMail org keys: two distinct am_us_ hex keys. Paste order is the
  // OLDER key (3a…, webguitest1) first; the vault labels f7… (webguitest2,
  // newest) as "api" — keep that mapping so upserts stay idempotent.
  const agentmailKeys = extractKeys(paste, /am_us_[0-9a-f]{64}/g, 2);
  const keenableKeys = extractKeys(paste, /keen_[A-Za-z0-9_]{20,80}/g, 1);
  const firecrawlKeys = extractKeys(paste, /fc-[0-9a-f]{32}/g, 1);
  const tinyfishKeys = extractKeys(paste, /sk-tinyfish-[A-Za-z0-9]{8,64}/g, 1);

  const KEYS: Array<{ service: string; label: string; secret: string; note: string }> = [
    {
      service: "agentmail",
      label: "api",
      secret: agentmailKeys[1],
      note: "webguitest2 — Full Access org key (newest)",
    },
    {
      service: "agentmail",
      label: "api-backup",
      secret: agentmailKeys[0],
      note: "webguitest1 — Full Access org key (older)",
    },
    {
      service: "keenable",
      label: "api",
      secret: keenableKeys[0],
      note: "100k free requests, renews Nov 29",
    },
    {
      service: "firecrawl",
      label: "api",
      secret: firecrawlKeys[0],
      note: "1,400 credits, resets Nov 29",
    },
    {
      service: "tinyfish",
      label: "api",
      secret: tinyfishKeys[0],
      note: "search+fetch free; browser automation residential proxies",
    },
  ];

  void (async () => {
    for (const k of KEYS) {
      const { keyId, cipher } = encryptSecret(k.secret);
      await db.credential.upsert({
        where: { service_label: { service: k.service, label: k.label } },
        create: { service: k.service, label: k.label, keyId, cipher },
        update: { keyId, cipher },
      });
      // P7: masked prefix only — same 8-char masking the secret scanner prints.
      console.log(`VAULT OK: ${k.service}/${k.label} masked=${k.secret.slice(0, 8)}*** (${k.note})`);
    }
    const total = await db.credential.count();
    console.log("vault credentials total:", total);
  })().then(() => process.exit(0)).catch((e) => {
    console.error("FAIL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

main();
