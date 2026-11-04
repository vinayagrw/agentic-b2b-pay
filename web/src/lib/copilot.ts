import type { SSEMessage } from "./stream";

export type Source = { tool: string; ids: string[]; links: { id: string; href: string }[] };
export type Proposal = { id: string; kind: string; label: string; method: "POST"; path: string; body: Record<string, unknown>; target: string; allowed: boolean; reason: string };
export type Answer = { question: string; answer: string; sources: Source[]; proposals: Proposal[]; mode: string; fallback?: string };
export type Folded = { text: string; tools: { tool: string; rows: number; error: string | null }[]; step: string; done: Answer | null; failed: string | null };

export const TOOL_NAMES: Record<string, string> = { spendBySupplier: "Spend by supplier", paymentsByStatus: "Payments by status", pendingApprovals: "Pending approvals", entityBalances: "Entity balances", fxExposure: "FX exposure", openInvoices: "Open invoices", whyPayment: "Why this payment" };

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
