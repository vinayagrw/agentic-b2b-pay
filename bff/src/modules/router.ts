import { isUsdc, type Rail, type RouteDecision, type RouteOption } from "@b2b/shared";
import type { RailQuote } from "../rails/types.js";

/** One candidate rail: the adapter's quote plus whether its keys are present for this tenant's environment. */
export type RailCandidate = RailQuote & { configured: boolean; notConfiguredReason?: string };
export type RouteInput = {
  amount: number; urgency: "standard" | "urgent";
  mandateRails: Rail[]; supplierRails: Rail[]; supplierPreferred: Rail;
  supplierHasWallet: boolean; supplierScreening: "clear" | "flagged"; supplierCountry: string;
  candidates: RailCandidate[];
};

/** Deterministic router. Score = cost + speed + preference. Hard filters for keys, limits, mandate, supplier acceptance and compliance. */
export function routePayment(i: RouteInput): RouteDecision {
  const options: RouteOption[] = i.candidates.map((r) => {
    const why: string[] = [];
    let eligible = true;
    if (!r.configured) { eligible = false; why.push(`Not configured${r.notConfiguredReason ? ": " + r.notConfiguredReason : ""}`); }
    if (!i.mandateRails.includes(r.rail)) { eligible = false; why.push("Not allowed by mandate"); }
    if (!i.supplierRails.includes(r.rail)) { eligible = false; why.push("Supplier does not accept"); }
    if (i.amount > r.maxAmount) { eligible = false; why.push(`Above rail limit ${r.maxAmount}`); }
    if (isUsdc(r.rail) && !i.supplierHasWallet) { eligible = false; why.push("No supplier wallet on file"); }
    if (isUsdc(r.rail) && i.supplierScreening === "flagged") { eligible = false; why.push("Supplier wallet flagged in screening"); }
    const feeUsd = r.feeUsd;
    const costScore = 40 * (1 - Math.min(feeUsd / Math.max(i.amount * 0.03, 1), 1));
    const speedWeight = i.urgency === "urgent" ? 40 : 20;
    const speedScore = speedWeight * (r.settleMinutes <= 5 ? 1 : r.settleMinutes <= 1440 ? 0.5 : 0.1);
    const prefScore = r.rail === i.supplierPreferred ? 25 : 0;
    const crossBorder = i.supplierCountry !== "US" && isUsdc(r.rail) ? 10 : 0;
    const score = eligible ? Math.round((costScore + speedScore + prefScore + crossBorder) * 10) / 10 : 0;
    if (eligible) why.push(`Fee ${feeUsd.toFixed(2)} USD`, `Settles in ${r.settleMinutes < 60 ? r.settleMinutes + " min" : r.settleMinutes / 1440 + " day"}`, ...(prefScore ? ["Supplier preferred rail"] : []));
    return { rail: r.rail, eligible, feeUsd, settleMinutes: r.settleMinutes, score, why };
  });
  const best = options.filter((o) => o.eligible).sort((a, b) => b.score - a.score || a.feeUsd - b.feeUsd)[0];
  return best
    ? { rail: best.rail, options, reason: `${best.rail} scored ${best.score}: ${best.why.join(", ")}` }
    : { rail: null, options, reason: "No eligible rail, payment held for treasury review" };
}
