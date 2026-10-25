/* One-off diagnostic: probe the stored Supabase pooler URI (sanitized output). */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const row = await db.credential.findUnique({
  where: { service_label: { service: "supabase", label: "supabase-db-url" } },
});
if (!row) {
  console.log("no pooler uri stored");
  process.exit(0);
}
const { decryptSecret } = await import("/home/z/my-project/src/lib/crypto.ts");
const uri: string = decryptSecret(row.cipher);
const scrub = (s: string) =>
  s
    .replace(/:\/\/([^:]+):([^@]+)@/, "://<user>:<pass>@")
    .replace(/password=[^&\s]+/gi, "password=<scrubbed>");

let u: URL;
try {
  u = new URL(uri);
} catch {
  console.log("PARSE FAIL");
  process.exit(0);
}
console.log("pooler host:", u.hostname, "port:", u.port || "5432", "sslmode:", u.searchParams.get("sslmode"));
const port = Number(u.port || 5432);
try {
  const sock = await Bun.connect({ hostname: u.hostname, port, socket: { data() {} } });
  console.log("TCP connect: OK (port open)");
  sock.end();
} catch (e) {
  console.log("TCP connect: FAIL:", (e instanceof Error ? e.message : String(e)).slice(0, 120));
}

try {
  const { default: postgres } = await import("postgres");
  const sql = postgres(uri, { ssl: "require", prepare: false, max: 1, connect_timeout: 8, idle_timeout: 3 });
  const t = await sql`select 1 as ok`;
  console.log("postgres select 1:", JSON.stringify(t));
  try {
    const c1 = await sql`select count(*)::int as n from nexus_mirror_interactions`;
    const c2 = await sql`select count(*)::int as n from nexus_mirror_lessons`;
    console.log("mirror rows: interactions =", c1[0].n, ", lessons =", c2[0].n);
  } catch (e) {
    console.log("mirror table check FAIL:", scrub(e instanceof Error ? e.message : String(e)).slice(0, 200));
  }
  await sql.end({ timeout: 2 });
} catch (e) {
  console.log("postgres probe FAIL:", scrub(e instanceof Error ? e.message : String(e)).slice(0, 200));
}
await db.$disconnect();
