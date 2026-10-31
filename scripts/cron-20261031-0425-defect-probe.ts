// cron-20261031-0425 defect probe — READONLY (bun:sqlite readonly mode)
// Quantifies the v38.6 target class: zero-model fallback rows + >15s research rows.
import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
const H = (h: number) => Date.now() - h * 3600_000;
const q = (sql: string) => db.query(sql).all() as Record<string, unknown>[];

console.log("== last 24h: canned/label-lie rows (web-fallback & static-floor modelIds) ==");
for (const r of q(`SELECT modelId, model, COUNT(*) n, ROUND(AVG(latencyMs)) avgMs, MAX(latencyMs) maxMs
                   FROM InteractionLog
                   WHERE createdAt > ${H(24)} AND modelId IN ('web-fallback','static-floor')
                   GROUP BY modelId, model ORDER BY n DESC`)) console.log(JSON.stringify(r));

console.log("== last 24h: research-lane rows by model (latency truth) ==");
for (const r of q(`SELECT model, COUNT(*) n, ROUND(AVG(latencyMs)) avgMs, MAX(latencyMs) maxMs
                   FROM InteractionLog
                   WHERE createdAt > ${H(24)} AND route LIKE '%research%'
                   GROUP BY model ORDER BY n DESC LIMIT 10`)) console.log(JSON.stringify(r));

console.log("== last 24h: rows over 15s (any route) ==");
for (const r of q(`SELECT model, route, latencyMs, substr(message,1,40) msg
                   FROM InteractionLog
                   WHERE createdAt > ${H(24)} AND latencyMs > 15000
                   ORDER BY latencyMs DESC LIMIT 10`)) console.log(JSON.stringify(r));

console.log("== total rows last 24h / research rows ==");
for (const r of q(`SELECT COUNT(*) total,
                   SUM(CASE WHEN route LIKE '%research%' THEN 1 ELSE 0 END) research
                   FROM InteractionLog WHERE createdAt > ${H(24)}`)) console.log(JSON.stringify(r));
