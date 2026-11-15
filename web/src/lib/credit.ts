/** Shared helpers for the Credit line pages. The lender is simulated, so every screen says so. */
export type CreditLine = { tenantId: string; bankId: string; limit: number; aprPct: number; currency: string; status: "active" | "frozen"; setBy: string; updatedAt: string };
export type CreditUsage = { limit: number; outstanding: number; pending: number; available: number; usedPct: number };
export type CreditDraw = { id: string; amount: number; currency: string; aprPct: number; purpose: string; status: string; outstanding: number; interestPaid: number; requestedBy: string; requestedByName: string | null; decidedBy: string | null; decidedByName: string | null; journalId: string | null; createdAt: string; fundedAt: string | null; needsStepUp: boolean };
export type CreditRepayment = { id: string; drawId: string; principal: number; interest: number; days: number; journalId: string; createdAt: string };
export type CreditView = { lender: string; note: string; line: CreditLine | null; usage: CreditUsage; draws: CreditDraw[]; repayments: CreditRepayment[]; stepUpThresholdUsd: number; accounts: { cash: string; liability: string; interest: string } };
export type BankExposure = { bankId: string; name: string; cap: number; outstanding: number; pending: number; committed: number; headroom: number; lines: number };
export type CreditOps = { lender: string; note: string; stepUpThresholdUsd: number; banks: BankExposure[]; clients: ({ tenantId: string; name: string; bankId: string | null; line: CreditLine | null } & CreditUsage)[] };

export const DRAW_STATUS: Record<string, string> = { pending_approval: "Waiting for approval", funded: "Drawn", repaid: "Repaid", rejected: "Rejected" };
export const drawTone = (s: string): "ok" | "warn" | "bad" | "neutral" => s === "funded" ? "ok" : s === "pending_approval" ? "warn" : s === "rejected" ? "bad" : "neutral";
export const money = (n: number, cur = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n ?? 0);
/** Share of a limit or cap in use, 0 to 100. */
export const pct = (used: number, total: number) => total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0;
/** Why a draw amount cannot be asked for, or null when it can. The server checks the same rules again. */
export function drawBlock(amount: number, line: CreditLine | null, usage: CreditUsage): string | null {
  if (!line) return "Your bank has not set up a credit line yet.";
  if (line.status !== "active") return "The credit line is frozen by the bank.";
  if (!(amount > 0)) return "Enter an amount above zero.";
  if (amount > usage.available) return `This is over the credit limit. ${money(usage.available, line.currency)} is left.`;
  return null;
}
/** What a decider can do with a draw. The maker can never approve their own draw. */
export function decideBlock(d: Pick<CreditDraw, "status" | "requestedBy">, meId: string | undefined, canApprove: boolean): string | null {
  if (d.status !== "pending_approval") return "Already decided";
  if (d.requestedBy === meId) return "You asked for this draw, so a second person must approve it";
  if (!canApprove) return "Your role cannot approve draws";
  return null;
}
/** Simple interest estimate for a repayment today. A demo figure, the server works out the real one. */
export function interestEstimate(principal: number, aprPct: number, fundedAt: string | null, now = Date.now()) {
  const days = Math.max(1, Math.ceil((now - Date.parse(fundedAt ?? new Date(now).toISOString())) / 864e5));
  return { days, interest: Math.round(principal * (aprPct / 100) * (days / 365) * 100) / 100 };
}
