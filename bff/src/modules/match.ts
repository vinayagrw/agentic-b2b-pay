import type { MatchResult, PoLine } from "@b2b/shared";

/** 3-way match: PO vs goods receipt vs invoice, price and quantity within tolerance. */
export function threeWayMatch(
  poLines: PoLine[], grLines: { sku: string; qty: number }[], invLines: { sku: string; qty: number; unitPrice: number }[], tolerancePct = 2,
): MatchResult {
  const lines: MatchResult["lines"] = [];
  const skus = new Set([...poLines.map((l) => l.sku), ...invLines.map((l) => l.sku)]);
  for (const sku of skus) {
    const po = poLines.find((l) => l.sku === sku);
    const gr = grLines.filter((l) => l.sku === sku).reduce((a, b) => a + b.qty, 0);
    const inv = invLines.find((l) => l.sku === sku);
    const poQty = po?.qty ?? 0, poPrice = po?.unitPrice ?? 0, invQty = inv?.qty ?? 0, invPrice = inv?.unitPrice ?? 0;
    const notes: string[] = [];
    if (!po) notes.push("Line not on PO");
    if (!inv) notes.push("Line not invoiced");
    if (invQty > gr) notes.push(`Invoiced ${invQty} but received ${gr}`);
    if (invQty > poQty) notes.push(`Invoiced ${invQty} above ordered ${poQty}`);
    const priceVar = poPrice ? (Math.abs(invPrice - poPrice) / poPrice) * 100 : invPrice ? 100 : 0;
    if (priceVar > tolerancePct) notes.push(`Price variance ${priceVar.toFixed(2)} percent above ${tolerancePct} percent`);
    lines.push({ sku, poQty, grQty: gr, invQty, poPrice, invPrice, ok: notes.length === 0 || (notes.length === 1 && notes[0] === "Line not invoiced"), note: notes.join(". ") || "OK" });
  }
  const po = round(poLines.reduce((a, l) => a + l.qty * l.unitPrice, 0));
  const invoice = round(invLines.reduce((a, l) => a + l.qty * l.unitPrice, 0));
  const variancePct = po ? round((Math.abs(invoice - po) / po) * 100) : 100;
  const ok = lines.every((l) => l.ok) && variancePct <= tolerancePct;
  return { status: ok ? "matched" : "exception", tolerancePct, lines, totals: { po, invoice, variancePct } };
}
export const round = (n: number) => Math.round(n * 100) / 100;
