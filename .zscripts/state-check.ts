import { db } from "@/lib/db";

async function main() {
  const settings = await db.setting.findMany({ select: { key: true, value: true } });
  console.log("SETTINGS KEYS:", JSON.stringify(settings.map(s => s.key)));
  const pwHash = settings.find(s => s.key === "panel.passwordHash");
  console.log("panel.passwordHash set:", !!pwHash?.value);
  console.log("env PANEL_PASSWORD:", process.env.PANEL_PASSWORD);
  const exaUsage = settings.find(s => s.key.startsWith("exa.usage"));
  console.log("exa usage:", exaUsage?.value?.slice(0, 300) ?? "(none)");
  const digest = settings.find(s => s.key === "exa.digest");
  console.log("exa.digest set:", !!digest?.value, digest?.value?.slice(0, 200));
  const creds = await db.credential.findMany({ select: { service: true, label: true, keyId: true } });
  console.log("VAULT:", JSON.stringify(creds));
}
main().catch(e => { console.error("ERR", e); process.exit(1); });
