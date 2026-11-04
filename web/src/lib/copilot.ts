import type { SSEMessage } from "./stream";

export type Source = { tool: string; ids: string[]; links: { id: string; href: string }[] };
export type Proposal = { id: string; kind: string; label: string; method: "POST"; path: string; body: Record<string, unknown>; target: string; allowed: boolean; reason: string; detail?: string };
export type ChartSpec = { type: "bar" | "line" | "area" | "donut" | "stacked" | "table"; title: string; x: string; y: string[]; series?: string; rows: Record<string, string | number>[] };
export type Chart = { kind: "bar" | "donut" | "table"; title: string; series: { label: string; value: number }[]; columns: string[]; rows: (string | number)[][]; spec?: ChartSpec };
export type Offer = { id: string; kind: string; label: "Offer"; title: string; body: string; trigger: string };
export type Answer = { id: string; threadId: string | null; question: string; answer: string; sources: Source[]; proposals: Proposal[]; offers?: Offer[]; chart: Chart | null; refused: string | null; mode: string; fallback?: string; vote?: "up" | "down" | null; memories?: { id: string; kind: string; text: string }[] };
export type Memory = { id: string; kind: "preference" | "fact" | "alias"; text: string; sourceAnswerId: string | null; createdAt: string };
export type Thread = { id: string; title: string; createdAt: string; updatedAt: string; answers?: Answer[] };
export type Folded = { text: string; tools: { tool: string; rows: number; error: string | null }[]; step: string; done: Answer | null; failed: string | null };

export const TOOL_NAMES: Record<string, string> = { query: "Grouped query", spendBySupplier: "Spend by supplier", paymentsByStatus: "Payments by status", pendingApprovals: "Pending approvals", entityBalances: "Entity balances", fxExposure: "FX exposure", openInvoices: "Open invoices", whyPayment: "Why this payment", riskInbox: "Risk inbox",
  mandates: "Mandates", fxLocksAndRates: "FX locks and rates", railHealth: "Rail health", cashForecast: "Cash forecast", supplierProfile: "Supplier profile", auditSearch: "Audit search", approvalRules: "Approval rules", riskScore: "Risk score", fxGainLoss: "FX gain or loss", dailyDigest: "What changed today", opsQueues: "Ops queues", riskEscalations: "Risk escalations", recurringPayments: "Recurring payments", tenants: "Tenants", railToggles: "Rail toggles", killSwitchState: "Kill switch", slaBreaches: "SLA breaches" };

/** The record a page shows, taken from the last path segment, for example pi-12 from /app/payments/pi-12. */
export function recordFromPath(path: string): string | undefined {
  const last = path.split("?")[0].split("/").filter(Boolean).pop() ?? "";
  return /^[a-z]{2,4}-[\w-]{1,40}$/.test(last) ? last : undefined;
}

/** Folds copilot SSE messages into what the panel shows. Pure so it can be tested. */
export function foldStream(ms: SSEMessage<any>[]): Folded {
  const f: Folded = { text: "", tools: [], step: "connecting", done: null, failed: null };
  for (const m of ms) {
    if (m.event === "status") f.step = String(m.data?.step ?? f.step);
    else if (m.event === "tool") f.tools.push({ tool: m.data.tool, rows: m.data.rows, error: m.data.error ?? null });
    else if (m.event === "token") { f.text += String(m.data?.text ?? ""); f.step = "streaming"; }
    else if (m.event === "done") { f.done = m.data as Answer; f.text = f.done.answer; f.step = "done"; }
    else if (m.event === "failed") { f.failed = String(m.data?.error ?? "failed"); f.step = "done"; }
  }
  return f;
}

/** Browser speech recognition, or null when the browser has none. */
export const speechCtor = (): any => (typeof window === "undefined" ? null : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);
export const SNAP_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
export const SNAP_MAX = 3 * 1024 * 1024;
/** Client side check before upload. The server checks again, including the file signature. */
export function snapProblem(f: { type: string; size: number }) {
  if (!SNAP_TYPES.includes(f.type)) return "Upload a PNG, JPEG, WEBP image or a PDF";
  if (!f.size) return "The file is empty";
  if (f.size > SNAP_MAX) return "The file is over 3 MB";
  return "";
}
