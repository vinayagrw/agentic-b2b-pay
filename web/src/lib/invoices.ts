export type InvoiceRiskSignal = { code: "near_duplicate"; invoiceId: string; detail: string };
/** A plain warning shown after an invoice is saved but looks like an earlier one. */
export function invoiceSubmitNote(inv: { id: string; riskSignals?: InvoiceRiskSignal[] } | null | undefined): string {
  const ids = (inv?.riskSignals ?? []).filter((s) => s.code === "near_duplicate").map((s) => s.invoiceId);
  if (!ids.length) return "";
  return `Saved as ${inv!.id}. Check it. It has the same supplier and amount as ${ids.join(", ")} from the last 7 days.`;
}
