/** Downloads the public OFAC SDN list into data/ofac. Run: npm run sdn:fetch --workspace bff */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSdn } from "../src/modules/sdn.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/ofac");
const FILES = { "sdn.csv": "https://www.treasury.gov/ofac/downloads/sdn.csv", "alt.csv": "https://www.treasury.gov/ofac/downloads/alt.csv" };
fs.mkdirSync(dir, { recursive: true });
for (const [name, url] of Object.entries(FILES)) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  const text = await r.text();
  fs.writeFileSync(path.join(dir, name), text);
  console.log(`${name}: ${text.length} bytes`);
}
const idx = parseSdn(fs.readFileSync(path.join(dir, "sdn.csv"), "utf8"), fs.readFileSync(path.join(dir, "alt.csv"), "utf8"));
fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), source: FILES, entries: idx.entries, names: idx.names.size, addresses: idx.addresses.size }, null, 2));
console.log(`Parsed ${idx.entries} entries, ${idx.names.size} names, ${idx.addresses.size} digital currency addresses`);
