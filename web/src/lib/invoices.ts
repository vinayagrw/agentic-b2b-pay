export type InvoiceRiskSignal = { code: "near_duplicate"; invoiceId: string; detail: string };
/** A plain warning shown after an invoice is saved but looks like an earlier one. */
export function invoiceSubmitNote(inv: { id: string; riskSignals?: InvoiceRiskSignal[] } | null | undefined): string {
  const ids = (inv?.riskSignals ?? []).filter((s) => s.code === "near_duplicate").map((s) => s.invoiceId);
  if (!ids.length) return "";
  return `Saved as ${inv!.id}. Check it. It has the same supplier and amount as ${ids.join(", ")} from the last 7 days.`;
}

export type ExceptionAction = "release" | "hold" | "accept" | "credit" | "resubmit";
type InvLike = { matchStatus: string; paid?: boolean; submittedBy?: string; supersededBy?: string; hold?: { on: boolean; reason?: string }; override?: { by: string; reason: string } };
/** Actions a user may take on an invoice that did not match, or on a matched one before it is paid. The server checks the same rules. */
export function exceptionActions(inv: InvLike, me: { id: string; permissions?: string[] } | null | undefined): ExceptionAction[] {
  if (!me || inv.paid || inv.supersededBy || inv.matchStatus === "unmatched") return [];
  const perms = me.permissions ?? []; const op = perms.includes("flow.operate"); const appr = perms.includes("payments.approve");
  const out: ExceptionAction[] = [];
  if (op) out.push(inv.hold?.on ? "release" : "hold");
  if (inv.matchStatus === "exception" && appr && inv.submittedBy !== me.id) out.push("accept");
  if (appr) out.push("credit");
  if (inv.matchStatus === "exception" && op) out.push("resubmit");
  return out;
}
/** A short line on why an invoice is in its state. */
export function invoiceStateLabel(inv: InvLike): string {
  if (inv.supersededBy) return `Replaced by ${inv.supersededBy}`;
  if (inv.hold?.on) return `On hold: ${inv.hold.reason ?? ""}`;
  if (inv.override) return `Accepted by ${inv.override.by}: ${inv.override.reason}`;
  return "";
}
