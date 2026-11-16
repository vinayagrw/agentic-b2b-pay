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
  if (appr && inv.submittedBy !== me.id) out.push("credit");
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
export type ActionForm = { reason?: string; amount?: string; text?: string };
export type ActionRequest = { path: string; body: Record<string, unknown> } | { error: string };
/** Turns the inline invoice action form into an API call, or a plain error to show next to the form. */
export function actionRequest(inv: { id: string; amount: number }, a: ExceptionAction, f: ActionForm): ActionRequest {
  const reason = (f.reason ?? "").trim();
  if (a === "resubmit") { const text = (f.text ?? "").trim(); return text ? { path: `/invoices/${inv.id}/resubmit`, body: { text } } : { error: "Paste the corrected invoice text." }; }
  if (a === "credit") {
    const amount = Number(f.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter a credit amount above 0." };
    if (amount > inv.amount) return { error: `Most you can credit is ${inv.amount}.` };
    if (!reason) return { error: "Add a reason." };
    return { path: `/invoices/${inv.id}/credit-notes`, body: { amount, reason } };
  }
  if (!reason) return { error: "Add a reason." };
  if (a === "accept") return { path: `/invoices/${inv.id}/override`, body: { reason } };
  return { path: `/invoices/${inv.id}/hold`, body: { reason, release: a === "release" } };
}
