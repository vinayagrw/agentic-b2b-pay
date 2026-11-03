import type { Rail, RouteDecision, RouteOption } from "@b2b/shared";

export type RailSpec = { rail: Rail; maxAmount: number; fee: (amt: number) => number; settleMinutes: number; label: string };
export const RAILS: RailSpec[] = [
  { rail: "card", maxAmount: 10000, fee: (a) => a * 0.025, settleMinutes: 2 * 1440, label: "Virtual card" },
  { rail: "ach", maxAmount: 1_000_000, fee: () => 0.5, settleMinutes: 1 * 1440, label: "Same day ACH" },
  { rail: "rtp", maxAmount: 1_000_000, fee: () => 1.0, settleMinutes: 1, label: "RTP instant" },
  { rail: "usdc", maxAmount: 5_000_000, fee: () => 0.25, settleMinutes: 1, label: "USDC on Base (simulated)" },
];

export type RouteInput = {
  amount: number; urgency: "standard" | "urgent";
  mandateRails: Rail[]; supplierRails: Rail[]; supplierPreferred: Rail;
  supplierHasWallet: boolean; supplierScreening: "clear" | "flagged"; supplierCountry: string;
};

/** Deterministic router. Score = cost + speed + preference. Hard filters for limits, mandate, supplier acceptance and compliance. */
export function routePayment(i: RouteInput): RouteDecision {
  const options: RouteOption[] = RAILS.map((r) => {
    const why: string[] = [];
    let eligible = true;
    if (!i.mandateRails.includes(r.rail)) { eligible = false; why.push("Not allowed by mandate"); }
    if (!i.supplierRails.includes(r.rail)) { eligible = false; why.push("Supplier does not accept"); }
    if (i.amount > r.maxAmount) { eligible = false; why.push(`Above rail limit ${r.maxAmount}`); }
    if (r.rail === "usdc" && !i.supplierHasWallet) { eligible = false; why.push("No supplier wallet on file"); }
    if (r.rail === "usdc" && i.supplierScreening === "flagged") { eligible = false; why.push("Supplier wallet flagged in screening"); }
    if (r.rail === "rtp" && i.supplierCountry !== "US") { eligible = false; why.push("RTP is US domestic only"); }
    const feeUsd = Math.round(r.fee(i.amount) * 100) / 100;
    const costScore = 40 * (1 - Math.min(feeUsd / Math.max(i.amount * 0.03, 1), 1));
    const speedWeight = i.urgency === "urgent" ? 40 : 20;
    const speedScore = speedWeight * (r.settleMinutes <= 5 ? 1 : r.settleMinutes <= 1440 ? 0.5 : 0.1);
    const prefScore = r.rail === i.supplierPreferred ? 25 : 0;
    const crossBorder = i.supplierCountry !== "US" && (r.rail === "usdc") ? 10 : 0;
    const score = eligible ? Math.round((costScore + speedScore + prefScore + crossBorder) * 10) / 10 : 0;
    if (eligible) why.push(`Fee ${feeUsd.toFixed(2)} USD`, `Settles in ${r.settleMinutes < 60 ? r.settleMinutes + " min" : r.settleMinutes / 1440 + " day"}`, ...(prefScore ? ["Supplier preferred rail"] : []));
    return { rail: r.rail, eligible, feeUsd, settleMinutes: r.settleMinutes, score, why };
  });
  const best = options.filter((o) => o.eligible).sort((a, b) => b.score - a.score || a.feeUsd - b.feeUsd)[0];
  return best
    ? { rail: best.rail, options, reason: `${best.rail.toUpperCase()} scored ${best.score}: ${best.why.join(", ")}` }
    : { rail: null, options, reason: "No eligible rail, payment held for treasury review" };
}
