import type { ErpEvent, PurchaseOrder, Supplier } from "./store.js";

/** Simulated ERP adapters. Payload shapes loosely mirror SAP S/4HANA OData PO and Coupa REST. */
export function erpCreatePo(po: PurchaseOrder, sup: Supplier, n: number): { ref: string; event: Omit<ErpEvent, "id"> } {
  if (sup.erp === "SAP") {
    const ref = `45000${String(n).padStart(5, "0")}`;
    return { ref, event: { system: "SAP", kind: "A_PurchaseOrder.create", at: new Date().toISOString(), payload: {
      PurchaseOrder: ref, CompanyCode: "1000", PurchaseOrderType: "NB", Supplier: sup.id, DocumentCurrency: po.currency,
      to_PurchaseOrderItem: po.lines.map((l, i) => ({ PurchaseOrderItem: String((i + 1) * 10), Material: l.sku, OrderQuantity: l.qty, NetPriceAmount: l.unitPrice })),
    } } };
  }
  const ref = `CPO-${n}`;
  return { ref, event: { system: "Coupa", kind: "purchase_orders.create", at: new Date().toISOString(), payload: {
    "po-number": ref, supplier: { name: sup.name }, currency: { code: po.currency },
    "order-lines": po.lines.map((l, i) => ({ "line-num": i + 1, description: l.description, quantity: l.qty, price: l.unitPrice })),
  } } };
}
export function erpPostPayment(sup: Supplier, erpRef: string, invoiceNo: string, amount: number, railRef: string, txHash: string | null): Omit<ErpEvent, "id"> {
  return sup.erp === "SAP"
    ? { system: "SAP", kind: "SupplierInvoice.clear", at: new Date().toISOString(), payload: { PurchaseOrder: erpRef, SupplierInvoiceIDByInvcgParty: invoiceNo, PaidAmount: amount, PaymentReference: railRef, BlockchainTxHash: txHash, ClearingStatus: "CLEARED" } }
    : { system: "Coupa", kind: "invoices.mark_paid", at: new Date().toISOString(), payload: { "invoice-number": invoiceNo, "po-number": erpRef, "payment-amount": amount, "payment-reference": railRef, status: "paid" } };
}
