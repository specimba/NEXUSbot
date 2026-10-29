/**
 * One-off vault-mirror restore (2026-10-29 reset): the wipe emptied ops/vault/
 * (untracked by design since the Oct-25 hygiene commit, so git cannot help),
 * which killed scripts/snapshot-backup.sh with NO_TOKEN. The github/user-token
 * credential row was restored from the owner's seal, so the live token can be
 * decrypted from the vault and re-mirrored to ops/vault/github.token using the
 * EXACT semantics of mirrorTokenForScripts (src/lib/connectors/github.ts):
 * no trailing newline, mode 0600, tmp+rename atomic, dir 0700.
 *
 * P7: the token value is never printed — only lengths/ids.
 *
 * Idempotent: safe to re-run.
 *
 * Run: bun scripts/restore-vault-mirror-20261029.ts
 */
import { mkdirSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "../src/lib/crypto";

const db = new PrismaClient();

async function main(): Promise<void> {
  const cred = await db.credential.findUnique({
    where: { service_label: { service: "github", label: "user-token" } },
  });
  if (!cred) throw new Error("github/user-token credential row not found in the vault");

  const token = decryptSecret(cred.cipher);
  if (token.length < 20) throw new Error("decrypted token is empty/malformed");

  const target = path.resolve(process.cwd(), "ops/vault/github.token");
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);

  const tmp = path.join(dir, `.github.token.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, token, { mode: 0o600 }); // no trailing newline — mirror semantics
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }

  console.log(`[vault-mirror] ops/vault/github.token restored from credential ${cred.id} (keyId ${cred.keyId}, ${token.length} chars, mode 0600)`);
}

main()
  .then(() => process.exit(0))
  .catch((e: Error) => {
    console.error(`[vault-mirror] FAILED: ${e.message}`);
    process.exit(1);
  });
