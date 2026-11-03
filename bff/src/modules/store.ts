import fs from "node:fs";
import path from "node:path";
import type { Rail, Category, PoLine, PolicyDecision, MatchResult, RouteDecision, ComplianceResult, InvoiceExtract } from "@b2b/shared";

export type Org = { id: string; legalName: string; type: "buyer" | "supplier"; kybStatus: "verified" | "pending"; country: string };
export type Agent = { id: string; orgId: string; name: string; publicKey: string; kyaStatus: "verified" | "unverified"; erpRole: string; protocols: string[]; status: "active" | "suspended" };
export type Mandate = {
  id: string; agentId: string; principalUserId: string; type: "intent";
  maxAmount: number; perTxnMax: number; approvalThreshold: number; currency: "USD";
  allowedSuppliers: string[]; allowedCategories: Category[]; allowedRails: Rail[];
  perSupplierLimit: Record<string, number>; validFrom: string; validTo: string; signature: string;
};
export type Supplier = { id: string; orgId: string; name: string; bankDetailsRef: string; walletAddress: string | null; preferredRail: Rail; acceptedRails: Rail[]; screeningStatus: "clear" | "flagged"; erp: "SAP" | "Coupa" };
export type CatalogItem = { sku: string; supplierId: string; description: string; category: Category; unitPrice: number; keywords: string[] };
export type PurchaseOrder = { id: string; buyerOrgId: string; supplierId: string; agentId: string; mandateId: string; erpRef: string | null; category: Category; lines: PoLine[]; total: number; currency: "USD"; status: "pending_approval" | "approved" | "rejected" | "received" | "invoiced" | "paid"; justification: string; policy: PolicyDecision; createdAt: string };
export type GoodsReceipt = { id: string; poId: string; lines: { sku: string; qty: number }[]; receivedAt: string };
export type Invoice = { id: string; poId: string; supplierId: string; number: string; amount: number; currency: "USD"; dueDate: string; extract: InvoiceExtract; extractedBy: string; matchStatus: "unmatched" | "matched" | "exception"; match?: MatchResult; erpApproval: "pending" | "approved"; paid: boolean };
export type PaymentIntent = { id: string; invoiceId: string; mandateId: string; amount: number; currency: "USD"; status: "created" | "routed" | "blocked" | "settled" | "denied"; idempotencyKey: string; route?: RouteDecision; explanation?: string; explainedBy?: string; compliance?: ComplianceResult; custody?: unknown; settlementId?: string; blockedReason?: string };
export type Settlement = { id: string; paymentIntentId: string; rail: Rail; railRef: string; txHash: string | null; chain: string | null; feeUsd: number; confirmedAt: string; status: "confirmed" };
export type LedgerEntry = { id: string; journalId: string; account: string; debit: number; credit: number; currency: string; ref: string };
export type Journal = { id: string; memo: string; ref: string; createdAt: string; entries: LedgerEntry[] };
export type EvidenceRecord = { id: string; seq: number; subjectType: string; subjectId: string; event: string; payload: unknown; payloadHash: string; prevHash: string; hash: string; createdAt: string };
export type ErpEvent = { id: string; system: "SAP" | "Coupa"; kind: string; payload: unknown; at: string };

export type Db = {
  orgs: Org[]; agents: Agent[]; mandates: Mandate[]; suppliers: Supplier[]; catalog: CatalogItem[];
  pos: PurchaseOrder[]; receipts: GoodsReceipt[]; invoices: Invoice[]; intents: PaymentIntent[];
  settlements: Settlement[]; journals: Journal[]; evidence: EvidenceRecord[]; erp: ErpEvent[];
  payeeChanges: PayeeChange[]; refunds: RefundIntent[]; alerts: { at: string; kind: string; detail: string }[];
  killSwitch: boolean; seq: number;
};
export type PayeeChange = { id: string; supplierId: string; field: "walletAddress" | "bankDetailsRef"; newValue: string; source: "erp"; requestedBy: string; approvals: string[]; callbackVerified: boolean; status: "pending" | "applied" | "rejected"; createdAt: string };
export type RefundIntent = { id: string; originalIntentId: string; amount: number; reason: string; rail: Rail; status: "settled" | "rejected"; railRef?: string; txHash?: string | null; createdAt: string };

export const SANCTIONED_WALLETS = ["0xBAD0000000000000000000000000000000000BAD"];
export const SANCTIONED_NAMES = ["Rogue Metals Trading"];

export function seed(): Db {
  const now = new Date();
  const later = new Date(now.getTime() + 90 * 864e5);
  return {
    orgs: [
      { id: "org-acme", legalName: "Acme Manufacturing Inc", type: "buyer", kybStatus: "verified", country: "US" },
      { id: "org-northwind", legalName: "Northwind Components LLC", type: "supplier", kybStatus: "verified", country: "US" },
      { id: "org-contoso", legalName: "Contoso Logistics Ltd", type: "supplier", kybStatus: "verified", country: "GB" },
      { id: "org-fabrikam", legalName: "Fabrikam Metals SA", type: "supplier", kybStatus: "verified", country: "MX" },
    ],
    agents: [
      { id: "agt-buyer-1", orgId: "org-acme", name: "Acme procurement agent", publicKey: "", kyaStatus: "unverified", erpRole: "buyer.requisitioner", protocols: ["mcp", "a2a"], status: "active" },
      { id: "agt-supplier-1", orgId: "org-northwind", name: "Northwind billing agent", publicKey: "", kyaStatus: "unverified", erpRole: "supplier.biller", protocols: ["mcp"], status: "active" },
    ],
    mandates: [{
      id: "mdt-1", agentId: "agt-buyer-1", principalUserId: "usr-cfo-jane", type: "intent",
      maxAmount: 100000, perTxnMax: 40000, approvalThreshold: 10000, currency: "USD",
      allowedSuppliers: ["sup-northwind", "sup-contoso", "sup-fabrikam"], allowedCategories: ["mro", "components", "logistics"],
      allowedRails: ["card", "ach", "rtp", "usdc"], perSupplierLimit: { "sup-northwind": 60000, "sup-contoso": 20000, "sup-fabrikam": 30000 },
      validFrom: now.toISOString(), validTo: later.toISOString(), signature: "",
    }],
    suppliers: [
      { id: "sup-northwind", orgId: "org-northwind", name: "Northwind Components LLC", bankDetailsRef: "bank-ref-001", walletAddress: "0x9a1C00000000000000000000000000000000C0DE", preferredRail: "usdc", acceptedRails: ["ach", "rtp", "usdc"], screeningStatus: "clear", erp: "SAP" },
      { id: "sup-contoso", orgId: "org-contoso", name: "Contoso Logistics Ltd", bankDetailsRef: "bank-ref-002", walletAddress: null, preferredRail: "ach", acceptedRails: ["card", "ach"], screeningStatus: "clear", erp: "Coupa" },
      { id: "sup-fabrikam", orgId: "org-fabrikam", name: "Fabrikam Metals SA", bankDetailsRef: "bank-ref-003", walletAddress: SANCTIONED_WALLETS[0], preferredRail: "usdc", acceptedRails: ["ach", "usdc"], screeningStatus: "clear", erp: "SAP" },
    ],
    catalog: [
      { sku: "NW-BRG-6204", supplierId: "sup-northwind", description: "Ball bearing 6204 sealed", category: "components", unitPrice: 4.5, keywords: ["bearing", "bearings", "6204"] },
      { sku: "NW-MTR-750", supplierId: "sup-northwind", description: "Servo motor 750W", category: "components", unitPrice: 420, keywords: ["motor", "servo", "motors"] },
      { sku: "NW-GLV-NIT", supplierId: "sup-northwind", description: "Nitrile gloves box of 100", category: "mro", unitPrice: 12, keywords: ["glove", "gloves", "nitrile"] },
      { sku: "CT-FRT-LTL", supplierId: "sup-contoso", description: "LTL freight lane Chicago to Dallas", category: "logistics", unitPrice: 850, keywords: ["freight", "shipping", "ltl", "truck"] },
      { sku: "FB-STL-304", supplierId: "sup-fabrikam", description: "Stainless steel sheet 304 per ton", category: "components", unitPrice: 3100, keywords: ["steel", "stainless", "sheet"] },
    ],
    pos: [], receipts: [], invoices: [], intents: [], settlements: [], journals: [], evidence: [], erp: [], payeeChanges: [], refunds: [], alerts: [],
    killSwitch: false, seq: 1000,
  };
}

const FILE = process.env.DB_FILE ?? path.resolve(process.cwd(), "../data/db.json");
const PERSIST = process.env.DB_PERSIST !== "0" && process.env.LLM_MODE !== "mock-test";

export let db: Db = load();
function load(): Db {
  if (PERSIST && fs.existsSync(FILE)) { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* reseed */ } }
  return seed();
}
export function save() {
  if (!PERSIST) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
}
export function reset(fresh: Db = seed()) { db = fresh; save(); return db; }
export function nextId(prefix: string) { db.seq += 1; return `${prefix}-${db.seq}`; }
