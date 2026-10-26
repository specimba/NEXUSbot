import { loadVyceKey, DEFAULT_VYCE_BASE_URL, VYCE_ROLE_MODELS } from "@/lib/connectors/vyce";
const key = await loadVyceKey();
console.log("vyce key readable:", Boolean(key), "len:", key?.length ?? 0);
console.log("base:", DEFAULT_VYCE_BASE_URL);
console.log("roles:", JSON.stringify(VYCE_ROLE_MODELS, null, 1).slice(0, 800));
