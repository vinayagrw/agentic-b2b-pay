import { sql } from "../db.js";
import type { Rail, Category, PoLine, PolicyDecision, MatchResult, RouteDecision, ComplianceResult, InvoiceExtract } from "@b2b/shared";

export type Org = { id: string; tenantId?: string; legalName: string; type: "buyer" | "supplier"; kybStatus: "verified" | "pending"; country: string };
export type Agent = { id: string; tenantId?: string; orgId: string; name: string; publicKey: string; kyaStatus: "verified" | "unverified"; erpRole: string; protocols: string[]; status: "active" | "suspended" };
export type Mandate = {
  id: string; tenantId?: string; agentId: string; principalUserId: string; type: "intent";
  maxAmount: number; monthlyLimit?: number; perTxnMax: number; approvalThreshold: number; currency: "USD";
  allowedSuppliers: string[]; allowedCategories: Category[]; allowedRails: Rail[];
  perSupplierLimit: Record<string, number>; validFrom: string; validTo: string; signature: string;
};
export type Supplier = { id: string; tenantId?: string; orgId: string; name: string; bankDetailsRef: string; walletAddress: string | null; preferredRail: Rail; acceptedRails: Rail[]; screeningStatus: "clear" | "flagged"; erp: "SAP" | "Coupa"; onboarding?: Onboarding; entityId?: string; currency?: "USD" | "EUR" | "GBP" };
export type Onboarding = { status: "draft" | "submitted" | "verified" | "rejected"; token: string; email: string; invitedBy: string; invitedAt: string; kyb?: any; bank?: { tokenId: string; last4: string; bankName: string | null; routingNumber: string; holderName: string } | null; bankNote?: string; wallet?: { address: string; message: string; signature: string; verifiedAt: string } | null; screening?: any; submittedAt?: string; reviewedBy?: string; reviewNote?: string; reviewedAt?: string };
export type Approval = { ruleId: string | null; ruleName: string; levels: { role: string; count: number; approvals: { userId: string; at: string; comment: string }[] }[]; current: number; rejectedBy?: { userId: string; at: string; comment: string } };
export type CatalogItem = { tenantId?: string; sku: string; supplierId: string; description: string; category: Category; unitPrice: number; keywords: string[] };
export type PurchaseOrder = { id: string; tenantId?: string; requestedBy?: string; approval?: Approval; buyerOrgId: string; supplierId: string; agentId: string; mandateId: string; erpRef: string | null; category: Category; lines: PoLine[]; total: number; currency: "USD" | "EUR" | "GBP"; entityId?: string; usdEquivalent?: number; status: "pending_approval" | "approved" | "rejected" | "received" | "invoiced" | "paid"; justification: string; policy: PolicyDecision; createdAt: string };
export type GoodsReceipt = { id: string; poId: string; lines: { sku: string; qty: number }[]; receivedAt: string };
export type Invoice = { id: string; tenantId?: string; poId: string; supplierId: string; number: string; amount: number; currency: "USD" | "EUR" | "GBP"; entityId?: string; invoiceDate?: string; accrual?: { functionalCurrency: string; rate: number; usdRate?: number; rateDate?: string | null; amount: number; source: string; stale: boolean; at: string }; dueDate: string; extract: InvoiceExtract; extractedBy: string; matchStatus: "unmatched" | "matched" | "exception"; match?: MatchResult; erpApproval: "pending" | "approved"; paid: boolean };
export type TimelineEntry = { at: string; status: string; source: "platform" | "adapter" | "webhook" | "watcher"; detail: string };
export type PaymentIntent = { id: string; kind?: "payment" | "refund"; linkedIntentId?: string; refundIds?: string[]; bankFeeUsd?: number; invoiceId: string; mandateId: string; amount: number; currency: "USD"; entityId?: string; fx?: PaymentFx; status: "created" | "routed" | "blocked" | "denied" | "submitted" | "pending" | "settled" | "failed";
  rail?: Rail; env?: "sandbox" | "live"; providerRef?: string; explorerUrl?: string; dashboardUrl?: string; timeline?: TimelineEntry[]; createdAt?: string; tenantId?: string; idempotencyKey: string; route?: RouteDecision; explanation?: string; explainedBy?: string; compliance?: ComplianceResult; custody?: unknown; settlementId?: string; blockedReason?: string; risk?: RiskScore };
export type RiskReason = { code: "new_supplier" | "amount_spike" | "payee_change" | "odd_hour" | "velocity" | "first_rail" | "high_risk_corridor"; label: string; points: number; detail: string };
export type RiskScore = { score: number; level: "low" | "medium" | "high"; reasons: RiskReason[]; scoredAt: string; rail: string | null };
export type Settlement = { id: string; tenantId?: string; bankFeeUsd?: number; paymentIntentId: string; rail: Rail; railRef: string; txHash: string | null; chain: string | null; feeUsd: number; confirmedAt: string; status: "confirmed"; explorerUrl?: string; dashboardUrl?: string };
export type PaymentFx = { lockId: string; invoiceCurrency: string; invoiceAmount: number; settlementCurrency: string; settlementAmount: number; rate: number; functionalCurrency: string; functionalRate: number; source: string; rateDate: string | null; fetchedAt: string; stale: boolean; lockedAt: string; expiresAt: string;
  realised?: { apFunctional: number; cashFunctional: number; gainLoss: number; kind: "gain" | "loss" | "none"; journalId: string | null } };
export type LedgerEntry = { id: string; journalId: string; account: string; debit: number; credit: number; currency: string; ref: string; origCurrency?: string; origAmount?: number };
export type Journal = { id: string; tenantId?: string; entityId?: string; memo: string; ref: string; createdAt: string; entries: LedgerEntry[] };
export type EvidenceRecord = { id: string; seq: number; subjectType: string; subjectId: string; event: string; payload: unknown; payloadHash: string; prevHash: string; hash: string; createdAt: string };
export type ErpEvent = { id: string; system: "SAP" | "Coupa"; kind: string; payload: unknown; at: string };

export type Db = {
  orgs: Org[]; agents: Agent[]; mandates: Mandate[]; suppliers: Supplier[]; catalog: CatalogItem[];
  pos: PurchaseOrder[]; receipts: GoodsReceipt[]; invoices: Invoice[]; intents: PaymentIntent[];
  settlements: Settlement[]; journals: Journal[]; evidence: EvidenceRecord[]; erp: ErpEvent[];
  payeeChanges: PayeeChange[]; refunds: RefundIntent[]; alerts: { at: string; kind: string; detail: string; tenantId?: string }[];
  killSwitch: boolean; seq: number;
};
export type PayeeChange = { id: string; supplierId: string; field: "walletAddress" | "bankDetailsRef"; newValue: string; source: "erp"; requestedBy: string; approvals: string[]; callbackVerified: boolean; status: "pending" | "applied" | "rejected"; createdAt: string };
export type RefundIntent = { id: string; originalIntentId: string; amount: number; reason: string; rail: Rail; status: "settled" | "pending" | "failed" | "rejected"; railRef?: string; txHash?: string | null; createdAt: string };

export const SANCTIONED_WALLETS = ["0xBAD0000000000000000000000000000000000BAD"];
export const SANCTIONED_NAMES = ["Rogue Metals Trading"];

/** Seeded EUR order and invoice from Van Dijk, owned by Acme Europe BV. Unmatched until goods arrive. */
const EU_PO = (now: Date): PurchaseOrder => ({ id: "po-eu-seed", tenantId: "tnt-acme", buyerOrgId: "org-acme", supplierId: "sup-vandijk", agentId: "agt-buyer-1", mandateId: "mdt-1", erpRef: null, category: "components", currency: "EUR", entityId: "ent-acme-eu",
  lines: [{ sku: "VD-VLV-HYD", description: "Hydraulic valve DN25", qty: 20, unitPrice: 85 }], total: 1700, status: "invoiced", justification: "Seeded EUR order for Acme Europe BV", policy: { outcome: "allow", reasons: ["Seeded"], checks: [] } as any, createdAt: now.toISOString() });
const EU_INV = (now: Date): Invoice => ({ id: "inv-eu-seed", tenantId: "tnt-acme", poId: "po-eu-seed", supplierId: "sup-vandijk", number: "VD-2026-0001", amount: 1700, currency: "EUR", entityId: "ent-acme-eu", invoiceDate: now.toISOString().slice(0, 10), dueDate: new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10),
  extract: { invoiceNumber: "VD-2026-0001", poNumber: "po-eu-seed", supplierName: "Van Dijk Industrie BV", currency: "EUR", lines: [{ sku: "VD-VLV-HYD", qty: 20, unitPrice: 85 }], total: 1700, dueDate: new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10) } as any, extractedBy: "seed", matchStatus: "unmatched", erpApproval: "pending", paid: false });
export function seed(): Db {
  const now = new Date();
  const later = new Date(now.getTime() + 90 * 864e5);
  return {
    orgs: [
      { id: "org-acme", legalName: "Acme Manufacturing Inc", type: "buyer", kybStatus: "verified", country: "US" },
      { id: "org-northwind", legalName: "Northwind Components LLC", type: "supplier", kybStatus: "verified", country: "US" },
      { id: "org-contoso", legalName: "Contoso Logistics Ltd", type: "supplier", kybStatus: "verified", country: "GB" },
      { id: "org-fabrikam", legalName: "Fabrikam Metals SA", type: "supplier", kybStatus: "verified", country: "MX" },
      { id: "org-vandijk", legalName: "Van Dijk Industrie BV", type: "supplier", kybStatus: "verified", country: "NL" },
      { id: "org-globex", tenantId: "tnt-globex", legalName: "Globex Retail Group", type: "buyer", kybStatus: "verified", country: "US" },
      { id: "org-initech", tenantId: "tnt-globex", legalName: "Initech Packaging Co", type: "supplier", kybStatus: "verified", country: "US" },
      { id: "org-hooli", tenantId: "tnt-globex", legalName: "Hooli Store Fixtures Ltd", type: "supplier", kybStatus: "verified", country: "GB" },
    ],
    agents: [
      { id: "agt-buyer-1", orgId: "org-acme", name: "Acme procurement agent", publicKey: "", kyaStatus: "unverified", erpRole: "buyer.requisitioner", protocols: ["mcp", "a2a"], status: "active" },
      { id: "agt-supplier-1", orgId: "org-northwind", name: "Northwind billing agent", publicKey: "", kyaStatus: "unverified", erpRole: "supplier.biller", protocols: ["mcp"], status: "active" },
      { id: "agt-globex-1", tenantId: "tnt-globex", orgId: "org-globex", name: "Globex store ops agent", publicKey: "", kyaStatus: "unverified", erpRole: "buyer.requisitioner", protocols: ["mcp", "a2a"], status: "active" },
    ],
    mandates: [{
      id: "mdt-1", agentId: "agt-buyer-1", principalUserId: "usr-cfo-jane", type: "intent",
      maxAmount: 100000, perTxnMax: 40000, approvalThreshold: 10000, currency: "USD",
      allowedSuppliers: ["sup-northwind", "sup-contoso", "sup-fabrikam", "sup-vandijk"], allowedCategories: ["mro", "components", "logistics"],
      allowedRails: ["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"], perSupplierLimit: { "sup-northwind": 60000, "sup-contoso": 20000, "sup-fabrikam": 30000, "sup-vandijk": 30000 },
      validFrom: now.toISOString(), validTo: later.toISOString(), signature: "", monthlyLimit: 80000,
    }, {
      id: "mdt-globex-1", tenantId: "tnt-globex", agentId: "agt-globex-1", principalUserId: "usr-globex-gina", type: "intent",
      maxAmount: 50000, perTxnMax: 15000, approvalThreshold: 5000, currency: "USD", monthlyLimit: 30000,
      allowedSuppliers: ["sup-initech", "sup-hooli"], allowedCategories: ["mro", "logistics", "it"],
      allowedRails: ["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"], perSupplierLimit: { "sup-initech": 30000, "sup-hooli": 30000 },
      validFrom: now.toISOString(), validTo: later.toISOString(), signature: "",
    }],
    suppliers: [
      { id: "sup-northwind", orgId: "org-northwind", name: "Northwind Components LLC", bankDetailsRef: "bank-ref-001", walletAddress: "0x9a1C00000000000000000000000000000000C0DE", preferredRail: "onchain_usdc", acceptedRails: ["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"], screeningStatus: "clear", erp: "SAP" },
      { id: "sup-contoso", orgId: "org-contoso", name: "Contoso Logistics Ltd", bankDetailsRef: "bank-ref-002", walletAddress: null, preferredRail: "stripe_ach", acceptedRails: ["stripe_card", "stripe_ach"], screeningStatus: "clear", erp: "Coupa" },
      { id: "sup-fabrikam", orgId: "org-fabrikam", name: "Fabrikam Metals SA", bankDetailsRef: "bank-ref-003", walletAddress: SANCTIONED_WALLETS[0], preferredRail: "circle_usdc", acceptedRails: ["stripe_ach", "circle_usdc"], screeningStatus: "clear", erp: "SAP" },
      { id: "sup-vandijk", orgId: "org-vandijk", name: "Van Dijk Industrie BV", bankDetailsRef: "bank-ref-004", walletAddress: null, preferredRail: "stripe_ach", acceptedRails: ["stripe_card", "stripe_ach"], screeningStatus: "clear", erp: "SAP", entityId: "ent-acme-eu", currency: "EUR" },
      { id: "sup-initech", tenantId: "tnt-globex", orgId: "org-initech", name: "Initech Packaging Co", bankDetailsRef: "bank-ref-101", walletAddress: null, preferredRail: "stripe_ach", acceptedRails: ["stripe_card", "stripe_ach"], screeningStatus: "clear", erp: "Coupa" },
      { id: "sup-hooli", tenantId: "tnt-globex", orgId: "org-hooli", name: "Hooli Store Fixtures Ltd", bankDetailsRef: "bank-ref-102", walletAddress: "0x7E5700000000000000000000000000000000F1E0", preferredRail: "onchain_usdc", acceptedRails: ["stripe_ach", "circle_usdc", "onchain_usdc"], screeningStatus: "clear", erp: "SAP" },
    ],
    catalog: [
      { sku: "NW-BRG-6204", supplierId: "sup-northwind", description: "Ball bearing 6204 sealed", category: "components", unitPrice: 4.25, keywords: ["bearing", "bearings", "6204"] },
      { sku: "NW-MTR-750", supplierId: "sup-northwind", description: "Servo motor 750W", category: "components", unitPrice: 420, keywords: ["motor", "servo", "motors"] },
      { sku: "NW-GLV-NIT", supplierId: "sup-northwind", description: "Nitrile gloves box of 100", category: "mro", unitPrice: 12, keywords: ["glove", "gloves", "nitrile"] },
      { sku: "CT-FRT-LTL", supplierId: "sup-contoso", description: "LTL freight lane Chicago to Dallas", category: "logistics", unitPrice: 850, keywords: ["freight", "shipping", "ltl", "truck"] },
      { sku: "NW-SMP-KIT", supplierId: "sup-northwind", description: "Bearing sample kit", category: "components", unitPrice: 2.5, keywords: ["sample", "kit", "samples"] },
      { tenantId: "tnt-globex", sku: "IN-LBL-100", supplierId: "sup-initech", description: "Shelf label pack of 100", category: "mro", unitPrice: 1.2, keywords: ["label", "labels", "shelf"] },
      { tenantId: "tnt-globex", sku: "IN-BOX-M", supplierId: "sup-initech", description: "Shipping carton medium", category: "logistics", unitPrice: 0.9, keywords: ["box", "boxes", "carton", "cartons"] },
      { tenantId: "tnt-globex", sku: "HL-HOOK-25", supplierId: "sup-hooli", description: "Display hook set of 25", category: "mro", unitPrice: 3.4, keywords: ["hook", "hooks", "display"] },
      { tenantId: "tnt-globex", sku: "HL-TAB-01", supplierId: "sup-hooli", description: "Store tablet kiosk", category: "it", unitPrice: 640, keywords: ["tablet", "kiosk"] },
      { sku: "VD-VLV-HYD", supplierId: "sup-vandijk", description: "Hydraulic valve DN25", category: "components", unitPrice: 85, keywords: ["valve", "valves", "hydraulic"] },
      { sku: "FB-STL-304", supplierId: "sup-fabrikam", description: "Stainless steel sheet 304 per ton", category: "components", unitPrice: 3100, keywords: ["steel", "stainless", "sheet"] },
    ],
    pos: [EU_PO(now)], receipts: [], invoices: [EU_INV(now)], intents: [], settlements: [], journals: [], evidence: [], erp: [], payeeChanges: [], refunds: [], alerts: [],
    killSwitch: false, seq: 1000,
  };
}

export const TENANT = "tnt-acme";
export const tenantOf = (x: { tenantId?: string } | undefined | null) => x?.tenantId ?? TENANT;
const intentStatus = (s: PaymentIntent["status"]) => (s === "settled" || s === "pending" || s === "submitted" ? s : s === "routed" || s === "created" ? "submitted" : "failed");
const KV_KEYS = ["orgs", "catalog", "receipts", "erp", "payeeChanges", "refunds", "alerts", "killSwitch", "seq"] as const;

const LEGACY_RAIL: Record<string, Rail> = { card: "stripe_card", ach: "stripe_ach", rtp: "stripe_ach", usdc: "onchain_usdc" };
const railOf = (r: string) => (LEGACY_RAIL[r] ?? r) as Rail;
export const isLegacyRail = (r: string | null | undefined) => !!r && r in LEGACY_RAIL;
export const isSimulatedReceipt = (s: { chain?: string | null; railRef?: string | null }) => /sim/i.test(s.chain ?? "") || /^USDC-/.test(s.railRef ?? "");
/** Databases written before the provider rails keep working: old rail names map to the new ones. */
function upgrade(d: Db): Db {
  for (const s of d.suppliers) { s.preferredRail = railOf(s.preferredRail); s.acceptedRails = [...new Set(s.acceptedRails.map(railOf))]; }
  for (const m of d.mandates) m.allowedRails = [...new Set(m.allowedRails.map(railOf))];
  // Payments from the pre-adapter build (old rail names, fake receipts) are never relabelled as real ones.
  // Migration 006 deletes them from SQLite. This filter covers state loaded any other way.
  const legacy = new Set(d.intents.filter((i) => isLegacyRail(i.rail) || isLegacyRail(i.route?.rail)).map((i) => i.id));
  for (const st of d.settlements) if (isLegacyRail(st.rail) || isSimulatedReceipt(st)) legacy.add(st.paymentIntentId);
  d.intents = d.intents.filter((i) => !legacy.has(i.id));
  d.settlements = d.settlements.filter((st) => !legacy.has(st.paymentIntentId));
  d.journals = d.journals.filter((j) => !legacy.has(j.ref));
  // Seed rows added by later build steps (the Globex tenant, small demo items) are topped up by id.
  const s = seed();
  for (const k of ["orgs", "agents", "mandates", "suppliers"] as const) for (const x of s[k] as { id: string }[]) if (!(d[k] as { id: string }[]).some((y) => y.id === x.id)) (d[k] as unknown[]).push(x);
  for (const c of s.catalog) if (!d.catalog.some((y) => y.sku === c.sku)) d.catalog.push(c);
  for (const k of ["pos", "invoices"] as const) for (const x of s[k] as { id: string }[]) if (!(d[k] as { id: string }[]).some((y) => y.id === x.id)) (d[k] as unknown[]).push(x);
  const m1 = d.mandates.find((m) => m.id === "mdt-1");
  if (m1 && !m1.allowedSuppliers.includes("sup-vandijk")) { m1.allowedSuppliers.push("sup-vandijk"); m1.perSupplierLimit = { ...m1.perSupplierLimit, "sup-vandijk": 30000 }; }
  // Seeded Northwind takes card and ACH too, so the happy path can route to Stripe when the wallet has no USDC.
  const nw = d.suppliers.find((x) => x.id === "sup-northwind");
  if (nw) for (const r of ["stripe_card", "stripe_ach"] as Rail[]) if (!nw.acceptedRails.includes(r)) nw.acceptedRails.unshift(r);
  return d;
}
/** Loads the domain state from SQLite. An empty database is seeded. */
function load(): Db {
  const kv = sql.prepare("SELECT key, value FROM kv").all() as { key: string; value: string }[];
  if (!kv.length) { const d = seed(); write(d); return d; }
  const k = Object.fromEntries(kv.map((r) => [r.key, JSON.parse(r.value)]));
  const rows = (t: string, order = "rowid") => (sql.prepare(`SELECT data FROM ${t} ORDER BY ${order}`).all() as { data: string }[]).map((r) => JSON.parse(r.data));
  return upgrade({
    orgs: k.orgs ?? [], catalog: k.catalog ?? [], receipts: k.receipts ?? [], erp: k.erp ?? [], payeeChanges: k.payeeChanges ?? [], refunds: k.refunds ?? [], alerts: k.alerts ?? [],
    killSwitch: !!k.killSwitch, seq: k.seq ?? 1000,
    agents: rows("agents"), mandates: rows("mandates"), suppliers: rows("suppliers"), pos: rows("pos"), invoices: rows("invoices"),
    intents: rows("payment_intents"), settlements: rows("rail_events"), journals: rows("journals"), evidence: rows("audit", "seq"),
  });
}
/** Writes the whole domain state in one transaction. Demo volumes keep this cheap. */
function write(d: Db) {
  sql.transaction(() => {
    for (const t of ["agents", "mandates", "suppliers", "pos", "invoices", "payment_intents", "rail_events", "journals"]) sql.prepare(`DELETE FROM ${t}`).run();
    const ins = (t: string, cols: string[], vals: unknown[][]) => { const st = sql.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`); for (const v of vals) st.run(...v); };
    ins("agents", ["id", "tenant_id", "status", "data"], d.agents.map((a) => [a.id, a.tenantId ?? TENANT, a.status, JSON.stringify(a)]));
    ins("mandates", ["id", "tenant_id", "agent_id", "data"], d.mandates.map((m) => [m.id, m.tenantId ?? TENANT, m.agentId, JSON.stringify(m)]));
    ins("suppliers", ["id", "tenant_id", "status", "data"], d.suppliers.map((s) => [s.id, s.tenantId ?? TENANT, s.onboarding?.status ?? s.screeningStatus, JSON.stringify(s)]));
    ins("pos", ["id", "tenant_id", "status", "data"], d.pos.map((p) => [p.id, p.tenantId ?? TENANT, p.status, JSON.stringify(p)]));
    ins("invoices", ["id", "tenant_id", "status", "data"], d.invoices.map((i) => [i.id, i.tenantId ?? TENANT, i.matchStatus, JSON.stringify(i)]));
    ins("payment_intents", ["id", "tenant_id", "status", "data"], d.intents.map((i) => [i.id, i.tenantId ?? TENANT, intentStatus(i.status), JSON.stringify(i)]));
    ins("rail_events", ["id", "tenant_id", "intent_id", "kind", "data"], d.settlements.map((s) => [s.id, s.tenantId ?? TENANT, s.paymentIntentId, s.status, JSON.stringify(s)]));
    ins("journals", ["id", "tenant_id", "data"], d.journals.map((j) => [j.id, j.tenantId ?? TENANT, JSON.stringify(j)]));
    // audit is append only: insert new links, never rewrite old ones (reset truncates)
    const max = (sql.prepare("SELECT COALESCE(MAX(seq),0) m FROM audit").get() as { m: number }).m;
    if (d.evidence.length < max) sql.prepare("DELETE FROM audit").run();
    const from = d.evidence.length < max ? 0 : max;
    ins("audit", ["seq", "id", "subject_type", "subject_id", "event", "hash", "prev_hash", "data"], d.evidence.filter((e) => e.seq > from).map((e) => [e.seq, e.id, e.subjectType, e.subjectId, e.event, e.hash, e.prevHash, JSON.stringify(e)]));
    const kv = sql.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
    for (const key of KV_KEYS) kv.run(key, JSON.stringify(d[key]));
  })();
}

type Listener = (e: { type: string; at: string }) => void;
const listeners = new Set<Listener>();
export function onChange(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(type = "state.changed") { const e = { type, at: new Date().toISOString() }; for (const l of listeners) l(e); }

export let db: Db = load();
export function save() { write(db); emit(); }
/** Reload state from the current connection, used after useDb() in tests. */
export function reload() { db = load(); return db; }
/** Tables outside the domain object that a reset clears. Later migrations add to this list. */
export const RESET_TABLES = ["idempotency_keys", "provider_events", "cases", "approval_rules", "agent_keys", "onboarding_tokens", "recon_exceptions", "sweeps", "api_keys", "webhook_endpoints", "webhook_deliveries", "events", "purchase_mandates", "fx_locks", "legal_entities", "risk_reviews", "copilot_threads", "copilot_answers", "copilot_feedback", "snap_drafts", "mcp_tokens", "supplier_portal_tokens", "payment_schedules", "tenant_offers", "copilot_outcomes", "memories", "tenant_skills"];
export function reset(fresh: Db = seed()) {
  db = fresh;
  const have = new Set((sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
  for (const t of RESET_TABLES) if (have.has(t)) sql.prepare(`DELETE FROM ${t}`).run();
  save(); return db;
}
/** The domain state seen by one tenant. Null shows everything (operator on a bank tenant). */
export function scoped(tenantId: string | null): Db {
  if (!tenantId) return db;
  const f = <T extends { tenantId?: string }>(xs: T[]) => xs.filter((x) => tenantOf(x) === tenantId);
  const pos = f(db.pos); const poIds = new Set(pos.map((p) => p.id)); const intents = f(db.intents as any[]) as PaymentIntent[]; const piIds = new Set(intents.map((i) => i.id));
  const sups = f(db.suppliers); const supIds = new Set(sups.map((s) => s.id));
  const subj = new Set([...poIds, ...piIds, ...f(db.invoices).map((i) => i.id), ...f(db.agents).map((a) => a.id), ...supIds]);
  return { ...db, orgs: db.orgs.filter((o) => tenantOf(o) === tenantId || sups.some((s) => s.orgId === o.id)), agents: f(db.agents), mandates: f(db.mandates), suppliers: sups, catalog: f(db.catalog), pos,
    receipts: db.receipts.filter((r) => poIds.has(r.poId)), invoices: f(db.invoices), intents, settlements: db.settlements.filter((s) => piIds.has(s.paymentIntentId)), journals: f(db.journals),
    evidence: db.evidence.filter((e) => subj.has(e.subjectId)), payeeChanges: db.payeeChanges.filter((c) => supIds.has(c.supplierId)), refunds: db.refunds.filter((r) => piIds.has(r.originalIntentId)), erp: db.erp, alerts: db.alerts.filter((a) => tenantOf(a) === tenantId) };
}
export function nextId(prefix: string) { db.seq += 1; return `${prefix}-${db.seq}`; }
