import crypto from "node:crypto";
import { sql } from "../db.js";

/** Multi entity and FX. Rates come from a free public ECB feed (Frankfurter, no key). Rates are never invented. */
export const CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type Ccy = (typeof CURRENCIES)[number];
export type Entity = { id: string; tenantId: string; name: string; currency: Ccy; country: string; isDefault: boolean };
export type Rate = { base: string; quote: string; rate: number; rateDate: string | null; source: string; fetchedAt: string; stale: boolean; staleReason?: string };
export type FxLock = { id: string; tenantId: string; entityId: string; from: string; to: string; rate: number; functionalCurrency: string; functionalRate: number; source: string; rateDate: string | null; fetchedAt: string; stale: boolean; lockedAt: string; expiresAt: string; intentId: string | null; usedAt: string | null };

export class FxError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const SEED_ENTITIES: Entity[] = [
  { id: "ent-acme-us", tenantId: "tnt-acme", name: "Acme US Inc", currency: "USD", country: "US", isDefault: true },
  { id: "ent-acme-eu", tenantId: "tnt-acme", name: "Acme Europe BV", currency: "EUR", country: "NL", isDefault: false },
  { id: "ent-acme-uk", tenantId: "tnt-acme", name: "Acme UK Ltd", currency: "GBP", country: "GB", isDefault: false },
  { id: "ent-globex-us", tenantId: "tnt-globex", name: "Globex Retail Group", currency: "USD", country: "US", isDefault: true },
  { id: "ent-globex-uk", tenantId: "tnt-globex", name: "Globex Retail UK Ltd", currency: "GBP", country: "GB", isDefault: false },
];
export function seedEntities() {
  const ins = sql.prepare("INSERT OR IGNORE INTO legal_entities (id, tenant_id, name, currency, country, is_default) VALUES (?,?,?,?,?,?)");
  for (const e of SEED_ENTITIES) ins.run(e.id, e.tenantId, e.name, e.currency, e.country, e.isDefault ? 1 : 0);
}
const toEntity = (r: any): Entity => ({ id: r.id, tenantId: r.tenant_id, name: r.name, currency: r.currency, country: r.country, isDefault: !!r.is_default });
export function listEntities(tenantId: string | null): Entity[] {
  const rows = tenantId ? sql.prepare("SELECT * FROM legal_entities WHERE tenant_id = ? ORDER BY is_default DESC, id").all(tenantId) : sql.prepare("SELECT * FROM legal_entities ORDER BY tenant_id, is_default DESC, id").all();
  return rows.map(toEntity);
}
/** The entity, only when it belongs to the tenant. Null tenant means operator scope. */
export function getEntity(id: string, tenantId: string | null): Entity | null {
  const r = sql.prepare("SELECT * FROM legal_entities WHERE id = ?").get(id);
  const e = r ? toEntity(r) : null;
  return e && (!tenantId || e.tenantId === tenantId) ? e : null;
}
export function defaultEntity(tenantId: string): Entity | null { return listEntities(tenantId).find((e) => e.isDefault) ?? listEntities(tenantId)[0] ?? null; }

// Rate source. Tests swap the fetcher so no network is used.
export type RateFetcher = (base: string, quote: string) => Promise<{ rate: number; date: string | null; source: string }>;
const frankfurter: RateFetcher = async (base, quote) => {
  const ctl = AbortSignal.timeout(Number(process.env.FX_TIMEOUT_MS ?? 4000));
  const r = await fetch(`https://api.frankfurter.app/latest?from=${base}&to=${quote}`, { signal: ctl });
  if (!r.ok) throw new Error(`Frankfurter HTTP ${r.status}`);
  const j = (await r.json()) as { date?: string; rates?: Record<string, number> };
  const rate = j.rates?.[quote];
  if (typeof rate !== "number" || !(rate > 0)) throw new Error("Frankfurter returned no rate");
  return { rate, date: j.date ?? null, source: "Frankfurter (ECB reference rates)" };
};
let fetcher: RateFetcher = frankfurter;
export function setRateFetcher(f: RateFetcher | null) { fetcher = f ?? frankfurter; }
const FRESH_MS = () => Number(process.env.FX_CACHE_MS ?? 60 * 60 * 1000);
export const LOCK_MS = () => Number(process.env.FX_LOCK_MS ?? 15 * 60 * 1000);

const rowToRate = (r: any, stale: boolean, staleReason?: string): Rate => ({ base: r.base, quote: r.quote, rate: r.rate, rateDate: r.rate_date, source: r.source, fetchedAt: r.fetched_at, stale, ...(staleReason ? { staleReason } : {}) });
/** Last cached rate, or null. Never derived or guessed. */
export function cachedRate(base: string, quote: string): Rate | null {
  if (base === quote) return { base, quote, rate: 1, rateDate: null, source: "same currency", fetchedAt: new Date().toISOString(), stale: false };
  const r = sql.prepare("SELECT * FROM fx_rates WHERE base = ? AND quote = ?").get(base, quote) as any;
  return r ? rowToRate(r, Date.now() - Date.parse(r.fetched_at) > FRESH_MS(), Date.now() - Date.parse(r.fetched_at) > FRESH_MS() ? "Cached rate is older than the refresh window" : undefined) : null;
}
/** Fresh cache, else fetch, else the last cached rate labelled stale. No cached rate and no network means an error. */
export async function getRate(base: string, quote: string, opts: { force?: boolean } = {}): Promise<Rate> {
  for (const c of [base, quote]) if (!(CURRENCIES as readonly string[]).includes(c)) throw new FxError(422, `Unsupported currency ${c}`);
  if (base === quote) return cachedRate(base, quote)!;
  const hit = cachedRate(base, quote);
  if (hit && !hit.stale && !opts.force) return hit;
  try {
    const f = await fetcher(base, quote);
    const at = new Date().toISOString();
    sql.prepare("INSERT OR REPLACE INTO fx_rates (base, quote, rate, rate_date, source, fetched_at) VALUES (?,?,?,?,?,?)").run(base, quote, f.rate, f.date, f.source, at);
    return { base, quote, rate: f.rate, rateDate: f.date, source: f.source, fetchedAt: at, stale: false };
  } catch (e: any) {
    if (hit) return { ...hit, stale: true, staleReason: `Rate source unreachable (${e.message}). Using the last cached rate from ${hit.fetchedAt}.` };
    throw new FxError(503, `No FX rate for ${base} to ${quote}: the rate source is unreachable and nothing is cached. No rate is invented.`);
  }
}
// Rates on a past date (invoice date). Frankfurter serves ECB history by date. Tests swap this fetcher too.
export type DatedFetcher = (base: string, quote: string, date: string) => Promise<{ rate: number; date: string | null; source: string }>;
const frankfurterOn: DatedFetcher = async (base, quote, date) => {
  const r = await fetch(`https://api.frankfurter.app/${date}?from=${base}&to=${quote}`, { signal: AbortSignal.timeout(Number(process.env.FX_TIMEOUT_MS ?? 4000)) });
  if (!r.ok) throw new Error(`Frankfurter HTTP ${r.status}`);
  const j = (await r.json()) as { date?: string; rates?: Record<string, number> };
  const rate = j.rates?.[quote];
  if (typeof rate !== "number" || !(rate > 0)) throw new Error("Frankfurter returned no rate");
  return { rate, date: j.date ?? date, source: "Frankfurter (ECB reference rates, historical)" };
};
let datedFetcher: DatedFetcher = frankfurterOn;
export function setDatedRateFetcher(f: DatedFetcher | null) { datedFetcher = f ?? frankfurterOn; dated.clear(); }
const dated = new Map<string, Rate>();
export const today = () => new Date().toISOString().slice(0, 10);
/** Cached rate for a past date, or the current cached rate when the date is today or missing. */
export function cachedRateOn(base: string, quote: string, date?: string | null): Rate | null {
  if (base === quote || !date || date >= today()) return cachedRate(base, quote);
  return dated.get(`${base}${quote}${date}`) ?? null;
}
/** Fetches the rate on a past date. Never invented: no source means an error. */
export async function getRateOn(base: string, quote: string, date?: string | null): Promise<Rate> {
  if (base === quote || !date || date >= today()) return getRate(base, quote);
  const k = `${base}${quote}${date}`; const hit = dated.get(k); if (hit) return hit;
  try {
    const f = await datedFetcher(base, quote, date);
    const r: Rate = { base, quote, rate: f.rate, rateDate: f.date, source: f.source, fetchedAt: new Date().toISOString(), stale: false };
    dated.set(k, r); return r;
  } catch (e: any) { throw new FxError(503, `No FX rate for ${base} to ${quote} on ${date}: ${e.message}. No rate is invented.`); }
}
export const convert = (amount: number, rate: number) => Math.round(amount * rate * 100) / 100;

/** Locks the rate for one payment. Settlement must use this rate. */
export async function lockQuote(input: { tenantId: string; entityId: string; from: string; to: string; ttlMs?: number }): Promise<FxLock> {
  const ent = getEntity(input.entityId, input.tenantId);
  if (!ent) throw new FxError(404, "entity not found");
  const r = await getRate(input.from, input.to);
  const fr = await getRate(input.from, ent.currency);
  const lockedAt = new Date();
  const lock: FxLock = { id: `fxl-${crypto.randomBytes(6).toString("hex")}`, tenantId: input.tenantId, entityId: ent.id, from: input.from, to: input.to, rate: r.rate, functionalCurrency: ent.currency, functionalRate: fr.rate,
    source: r.source, rateDate: r.rateDate, fetchedAt: r.fetchedAt, stale: r.stale || fr.stale, lockedAt: lockedAt.toISOString(), expiresAt: new Date(lockedAt.getTime() + (input.ttlMs ?? LOCK_MS())).toISOString(), intentId: null, usedAt: null };
  sql.prepare("INSERT INTO fx_locks (id, tenant_id, entity_id, intent_id, data, expires_at, used_at, created_at) VALUES (?,?,?,?,?,?,?,?)").run(lock.id, lock.tenantId, lock.entityId, null, JSON.stringify(lock), lock.expiresAt, null, lock.lockedAt);
  return lock;
}
export function getLock(id: string, tenantId: string | null): FxLock | null {
  const r = sql.prepare("SELECT data FROM fx_locks WHERE id = ?").get(id) as { data: string } | undefined;
  const l = r ? (JSON.parse(r.data) as FxLock) : null;
  return l && (!tenantId || l.tenantId === tenantId) ? l : null;
}
export const isExpired = (l: FxLock, at = Date.now()) => at > Date.parse(l.expiresAt);
/** Binds an unexpired, unused lock to a payment. Expired locks are refused so a stale quote cannot be used. */
export function useLock(id: string, tenantId: string, intentId: string, check: { from: string; to: string; entityId: string }): FxLock {
  const l = getLock(id, tenantId);
  if (!l) throw new FxError(404, "FX lock not found");
  if (l.usedAt) throw new FxError(409, `FX lock ${id} was already used by ${l.intentId}`);
  if (isExpired(l)) throw new FxError(409, `FX lock ${id} expired at ${l.expiresAt}. Get a new quote.`);
  if (l.from !== check.from || l.to !== check.to || l.entityId !== check.entityId) throw new FxError(409, `FX lock ${id} is for ${l.from} to ${l.to} on ${l.entityId}`);
  l.intentId = intentId; l.usedAt = new Date().toISOString();
  sql.prepare("UPDATE fx_locks SET intent_id = ?, used_at = ?, data = ? WHERE id = ?").run(intentId, l.usedAt, JSON.stringify(l), id);
  return l;
}
export const FX_RESET_TABLES = ["fx_locks", "legal_entities"];
