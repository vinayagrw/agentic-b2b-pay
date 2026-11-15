/** Types and small helpers for the dispute evidence record of one paid order. Last 4 of a card only. */
export type EvMandate = { id: string; kind: "intent" | "cart"; signerId: string; signerKind: "user" | "agent"; hash: string; createdAt: string; keyFingerprint: string | null; signatureValid: boolean; body: any };
export type EvAuth = { id: string; at: string; merchant: string; amount: number; currency: string; decision: "approved" | "declined"; reason: string; status: string; source: string };
export type EvCard = { id: string; kind: string; issuerLabel: string; last4: string; expiry: string; status: string; currency: string; cartAmount: number | null; bindingHash: string | null; issuedBy: string; createdAt: string; authorizations: EvAuth[] };
export type EvEvent = { seq: number; at: string; subjectType: string; subjectId: string; event: string; actor: string | null; detail: unknown; hash: string };
export type Evidence = {
  generatedAt: string; tenantId: string;
  order: { id: string; status: string; supplier: string; total: number; currency: string; createdAt: string; erpRef: string | null; policy: { outcome: string; reasons: string[] } };
  mandates: { intent: EvMandate | null; cart: EvMandate | null; history?: (EvMandate & { supersededAt: string | null })[] };
  agent: { id: string; name: string; kyaStatus: string; status: string; keyFingerprint: string | null; authority: { id: string; principal: string; perTxnMax: number; approvalThreshold: number } | null } | null;
  approvals: { rule: string | null; needed: boolean; decisions: { level: number; role: string | null; decision: "approved" | "rejected"; userId: string; name: string; at: string; comment: string }[] };
  payment: { method: "card" | "rail"; cards: EvCard[]; railPayments: { id: string; kind: string; rail: string | null; amount: number; currency: string; status: string; createdAt: string | null }[] };
  timeline: EvEvent[]; chain: { valid: boolean; brokenAt: number | null };
};

export const evidenceFileName = (poId: string) => `evidence-${poId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
/** Turns an event code like card.authorization_approved into plain words. */
export const eventText = (event: string) => { const t = event.replace(/[._]/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
/** One plain line that sums up how the order was paid. */
export function paidLine(e: Pick<Evidence, "payment" | "order">) {
  const hit = e.payment.cards.flatMap((c) => c.authorizations.filter((a) => a.decision === "approved").map((a) => ({ c, a })))[0];
  if (e.payment.method === "card" && hit) return `Paid with a ${hit.c.kind.toLowerCase()} ending ${hit.c.last4}. ${hit.c.issuerLabel}.`;
  const p = e.payment.railPayments.find((x) => x.kind !== "refund" && x.status === "settled") ?? e.payment.railPayments[0];
  return p ? `Paid by ${p.rail ?? "a payment rail"}, payment ${p.id}.` : `Order ${e.order.id} is marked paid.`;
}
/** Saves the record as a JSON file in the browser. */
export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
export type EvidenceOrder = { id: string; supplier: string; total: number; currency: string; status: string; createdAt: string; method: "card" | "rail" };
/** True when the order has been paid, so an evidence record exists. Unpaid orders get no Evidence button. */
export function orderIsPaid(st: { pos?: { id: string; status: string }[]; invoices?: { poId: string; paid: boolean }[] } | undefined, poId: string) {
  return !!st && (st.pos?.find((p) => p.id === poId)?.status === "paid" || !!st.invoices?.some((i) => i.poId === poId && i.paid));
}
