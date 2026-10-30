// Trigger POST /api/backup/run via the panel (dev-server lineage — resident
// parent chain, so any mini-service the backup script respawns SURVIVES the
// agent-session reap). PANEL_PASSWORD is read from .env in-process and never
// printed, logged, or embedded (P7). Prints only the route's own response.
import { readFileSync } from "node:fs";

let password: string | null = null;
for (const line of readFileSync("/home/z/my-project/.env", "utf-8").split("\n")) {
  const t = line.trim();
  if (t.startsWith("PANEL_PASSWORD=")) {
    const v = t.slice("PANEL_PASSWORD=".length).trim();
    password =
      v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        ? v.slice(1, -1)
        : v;
    break;
  }
}
if (!password) {
  console.log("PANEL_PASSWORD missing — aborting");
  process.exit(1);
}

const login = await fetch("http://localhost:3000/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
  signal: AbortSignal.timeout(10_000),
});
const loginBody = (await login.json().catch(() => null)) as { token?: string } | null;
if (!login.ok || !loginBody?.token) {
  console.log(`login failed http=${login.status}`);
  process.exit(1);
}

const res = await fetch("http://localhost:3000/api/backup/run", {
  method: "POST",
  headers: { Authorization: `Bearer ${loginBody.token}` },
  signal: AbortSignal.timeout(120_000),
});
const body = await res.json().catch(() => null);
console.log(`http=${res.status}`);
console.log(JSON.stringify(body, null, 1).slice(0, 1200));
