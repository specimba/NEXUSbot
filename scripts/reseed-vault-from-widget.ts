/**
 * One-off vault recovery (v29.12): the sandbox reset rotated ENCRYPTION_KEY,
 * leaving every vault envelope unreadable (keyId c4ea58d2 → unknown). The
 * widget row still holds the owner's keys in plaintext variables, so this
 * script re-encrypts what is recoverable under the CURRENT key:
 *
 *   hyperbrowser/default  ← widget hyperbrowser_api_key
 *   upstash/rest          ← widget redis_rest_url + redis_rest_token (JSON)
 *   vyce/api              ← widget vyce_api_key
 *
 * Rows that are NOT recoverable from the widget (github×3, supabase/mgmt,
 * supabase/supabase-db-url, webshare/api) stay in place — the panel shows them
 * as "unreadable (key rotated out?)" until the owner re-enters them.
 *
 * Run: bun scripts/reseed-vault-from-widget.ts
 */
import { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();
const SEED_NAME = "Specimba Cyber AI Counter";

type WidgetVar = { name: string; value: string; secret?: boolean };

async function main() {
  const widget = await db.widget.findFirst({ where: { name: SEED_NAME } });
  if (!widget) throw new Error("widget row not found");
  let vars: WidgetVar[] = [];
  try {
    vars = JSON.parse(widget.variables || "[]") as WidgetVar[];
  } catch {
    throw new Error("widget variables not a JSON list");
  }
  const get = (name: string) =>
    vars.find((v) => v.name === name)?.value?.trim() ?? "";

  const entries: Array<{ service: string; label: string; secret: string }> = [];
  const hb = get("hyperbrowser_api_key");
  if (hb) entries.push({ service: "hyperbrowser", label: "default", secret: hb });
  const rurl = get("redis_rest_url");
  const rtok = get("redis_rest_token");
  if (rurl && rtok)
    entries.push({
      service: "upstash",
      label: "rest",
      secret: JSON.stringify({ url: rurl, token: rtok }),
    });
  const vyce = get("vyce_api_key");
  if (vyce) entries.push({ service: "vyce", label: "api", secret: vyce });
  // v29.13: groq key was only ever a widget variable — the cortex race needs
  // it in the vault so loadGroqKey() works for every panel code path.
  const groq = get("groq_api_key");
  if (groq) entries.push({ service: "groq", label: "api-key", secret: groq });

  for (const e of entries) {
    const enc = encryptSecret(e.secret);
    const existing = await db.credential.findUnique({
      where: { service_label: { service: e.service, label: e.label } },
    });
    if (existing) {
      await db.credential.update({
        where: { id: existing.id },
        data: { cipher: enc.cipher, keyId: enc.keyId },
      });
    } else {
      await db.credential.create({
        data: { service: e.service, label: e.label, cipher: enc.cipher, keyId: enc.keyId },
      });
    }
    console.log(`reseeded ${e.service}/${e.label} (keyId ${enc.keyId})`);
  }

  const all = await db.credential.findMany();
  let ok = 0;
  for (const r of all) {
    try {
      const { decryptSecret } = await import("../src/lib/crypto");
      decryptSecret(r.cipher);
      ok++;
    } catch {
      console.log(`STILL UNREADABLE (owner must re-enter): ${r.service}/${r.label}`);
    }
  }
  console.log(`vault readable: ${ok}/${all.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
