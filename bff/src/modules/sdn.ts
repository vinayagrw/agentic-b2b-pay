import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Local OFAC SDN screening. The list is downloaded by scripts/fetch-sdn.ts. Nothing here calls the network. */
export type SdnEntry = { uid: string; name: string; type: string; program: string; addresses: { asset: string; address: string }[] };
export type SdnHit = { source: "OFAC SDN" | "Demo watchlist"; uid: string; sdnName: string; program: string; matchedOn: "name" | "alias" | "wallet"; value: string; score: number; asset?: string };
export type SdnIndex = { entries: number; names: Map<string, { e: SdnEntry; alias: boolean }[]>; addresses: Map<string, { e: SdnEntry; asset: string }>; byUid: Map<string, SdnEntry>; fetchedAt: string | null };

/** RFC 4180 style CSV rows. OFAC files have no header row. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const NULL = (v: string | undefined) => (!v || v.trim() === "-0-" ? "" : v.trim());
const SUFFIX = /\b(llc|inc|ltd|limited|co|corp|corporation|company|sa|s a|gmbh|plc|llp|lp|fze|fzco|jsc|ojsc|pjsc|ooo|bv|ag|srl|spa)\b/g;
export const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();
const tokenKey = (s: string) => normName(s).split(" ").filter(Boolean).sort().join(" ");

export function parseSdn(sdnCsv: string, altCsv = ""): SdnIndex {
  const idx: SdnIndex = { entries: 0, names: new Map(), addresses: new Map(), byUid: new Map(), fetchedAt: null };
  const addName = (n: string, e: SdnEntry, alias: boolean) => { for (const k of new Set([normName(n), tokenKey(n)])) { if (!k) continue; const l = idx.names.get(k) ?? []; l.push({ e, alias }); idx.names.set(k, l); } };
  for (const r of csvRows(sdnCsv)) {
    if (r.length < 4 || !/^\d+$/.test(r[0].trim())) continue;
    const e: SdnEntry = { uid: r[0].trim(), name: NULL(r[1]), type: NULL(r[2]) || "entity", program: NULL(r[3]), addresses: [] };
    for (const m of NULL(r[11]).matchAll(/Digital Currency Address - ([A-Z0-9]+)\s+([0-9A-Za-z]+)/g)) e.addresses.push({ asset: m[1], address: m[2] });
    idx.byUid.set(e.uid, e); idx.entries++; addName(e.name, e, false);
    for (const a of e.addresses) idx.addresses.set(a.address.toLowerCase(), { e, asset: a.asset });
  }
  for (const r of csvRows(altCsv)) { const e = idx.byUid.get(r[0]?.trim()); const n = NULL(r[3]); if (e && n) addName(n, e, true); }
  return idx;
}

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/ofac");
let cached: SdnIndex | null | undefined;
/** Loads data/ofac once. Null when the list has not been downloaded. */
export function sdnIndex(): SdnIndex | null {
  if (cached !== undefined) return cached;
  try {
    const sdn = fs.readFileSync(path.join(DIR, "sdn.csv"), "utf8");
    const alt = fs.existsSync(path.join(DIR, "alt.csv")) ? fs.readFileSync(path.join(DIR, "alt.csv"), "utf8") : "";
    cached = parseSdn(sdn, alt);
    try { cached.fetchedAt = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8")).fetchedAt ?? null; } catch { cached.fetchedAt = null; }
  } catch { cached = null; }
  return cached;
}
/** Tests load a fixture list. Null forces the not loaded state. */
export function setSdnIndex(i: SdnIndex | null) { cached = i; }

/** Demo entries for the seeded sanctioned supplier. Shown as a separate source, never as OFAC. */
export const DEMO_NAMES = ["Rogue Metals Trading"];
export const DEMO_WALLETS = ["0xBAD0000000000000000000000000000000000BAD"];

export function screenName(name: string): SdnHit[] {
  const hits: SdnHit[] = [];
  if (DEMO_NAMES.some((n) => normName(n) === normName(name))) hits.push({ source: "Demo watchlist", uid: "demo-1", sdnName: DEMO_NAMES[0], program: "DEMO", matchedOn: "name", value: name, score: 100 });
  const idx = sdnIndex(); if (!idx || normName(name).length < 4) return hits;
  const seen = new Set<string>();
  for (const [k, score] of [[normName(name), 100], [tokenKey(name), 95]] as const) for (const m of idx.names.get(k) ?? []) {
    if (seen.has(m.e.uid)) continue; seen.add(m.e.uid);
    hits.push({ source: "OFAC SDN", uid: m.e.uid, sdnName: m.e.name, program: m.e.program, matchedOn: m.alias ? "alias" : "name", value: name, score: m.alias ? score - 5 : score });
  }
  return hits;
}
export function screenWallet(wallet: string | null | undefined): SdnHit[] {
  if (!wallet) return [];
  const w = wallet.toLowerCase(); const hits: SdnHit[] = [];
  if (DEMO_WALLETS.some((d) => d.toLowerCase() === w)) hits.push({ source: "Demo watchlist", uid: "demo-1", sdnName: DEMO_NAMES[0], program: "DEMO", matchedOn: "wallet", value: wallet, score: 100 });
  const m = sdnIndex()?.addresses.get(w);
  if (m) hits.push({ source: "OFAC SDN", uid: m.e.uid, sdnName: m.e.name, program: m.e.program, matchedOn: "wallet", value: wallet, score: 100, asset: m.asset });
  return hits;
}
export function sdnStatus() { const i = sdnIndex(); return i ? { loaded: true, entries: i.entries, addresses: i.addresses.size, fetchedAt: i.fetchedAt } : { loaded: false, entries: 0, addresses: 0, fetchedAt: null }; }
