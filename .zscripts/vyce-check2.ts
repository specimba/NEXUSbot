import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
const row = await db.credential.findFirst({ where: { service: "vyce", label: "api" } });
console.log("row:", row ? { id: row.id, keyId: row.keyId, cipherLen: row.cipher?.length, status: row.status } : null);
if (row) {
  try {
    const plain = await decryptSecret(row.cipher, row.keyId);
    console.log("decrypt ok, key len:", plain?.length ?? 0, "prefix:", plain?.slice(0, 6));
  } catch (e) {
    console.log("decrypt FAILED:", (e as Error).message);
  }
}
