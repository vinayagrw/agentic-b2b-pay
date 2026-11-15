/** Whether a payment can be retried, and a plain note when it cannot. The server checks the same rules. */
export function retryState(pi: { status: string; env?: string; retriedBy?: string; kind?: string }, attempts: number, max: number): { allowed: boolean; note: string | null } {
  if (pi.status !== "failed" || pi.kind === "refund") return { allowed: false, note: null };
  if ((pi.env ?? "sandbox") !== "sandbox") return { allowed: false, note: "Retry works in sandbox only." };
  if (pi.retriedBy) return { allowed: false, note: `Already retried as ${pi.retriedBy}.` };
  if (attempts >= max) return { allowed: false, note: `Attempt limit reached: ${attempts} of ${max}.` };
  return { allowed: true, note: null };
}
export const canAchReturn = (pi: { status: string; rail?: string; env?: string; kind?: string }) =>
  pi.status === "settled" && pi.rail === "stripe_ach" && pi.kind !== "refund" && (pi.env ?? "sandbox") === "sandbox";
export const ACH_CODES = [["R01", "Insufficient funds"], ["R02", "Account closed"], ["R03", "No account found"], ["R04", "Invalid account number"], ["R29", "Not authorized"]] as const;
