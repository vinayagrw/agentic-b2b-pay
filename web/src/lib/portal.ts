/** Link to a remittance advice file for one payment on the supplier portal. */
export const remittanceUrl = (token: string, paymentId: string, format: "csv" | "html") =>
  `/api/supplier-portal/${encodeURIComponent(token)}/payments/${encodeURIComponent(paymentId)}/remittance.${format}`;
/** Remittance and disputes are only offered for paid payments. */
export const isPaid = (p: { status?: string }) => p.status === "settled";
/** Plain label for a mock notice kind. */
export const noticeLabel = (k: string) => ({ payment_sent: "Payment sent", invoice_received: "Invoice received", dispute_opened: "Dispute opened" } as Record<string, string>)[k] ?? k;
