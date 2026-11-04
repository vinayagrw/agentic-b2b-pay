/** Registers the Circle sandbox entity secret once and saves the recovery file to data/keys. Run: npm run circle:register */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";
import { secret } from "../src/config.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/keys");
const apiKey = secret("CIRCLE_API_KEY"); const entitySecret = secret("CIRCLE_ENTITY_SECRET");
if (!apiKey || !entitySecret) { console.error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set in .env"); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
try {
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: dir });
  console.log(`Entity secret registered. Recovery file saved under ${dir}`);
} catch (e: any) {
  const msg = String(e?.response?.data?.message ?? e?.message ?? e);
  if (/already/i.test(msg)) { console.log("Entity secret is already set for this account. Nothing to do."); process.exit(0); }
  console.error(`Registration failed: ${msg.slice(0, 300)}`); process.exit(1);
}
