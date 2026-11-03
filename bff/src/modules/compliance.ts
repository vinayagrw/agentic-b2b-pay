import crypto from "node:crypto";
import type { ComplianceResult, Rail } from "@b2b/shared";
import { SANCTIONED_NAMES, SANCTIONED_WALLETS } from "./store.js";

/** Large transfer marker. A Travel Rule record is built for every stablecoin send regardless of amount. */
export const TRAVEL_RULE_THRESHOLD_USD = 3000;
export const HIGH_RISK_KYT = ["0xMIX0000000000000000000000000000000000M1X"];

export type ComplianceInput = {
  rail: Rail; amount: number;
  originator: { name: string; orgId: string; country: string; wallet?: string };
  beneficiary: { name: string; orgId: string; country: string; wallet: string | null; kybVerified: boolean };
};

/** Simulated screening provider. Deterministic. KYB, name sanctions, OFAC wallet list and KYT are separate steps. */
export function screen(i: ComplianceInput): ComplianceResult {
  const ref = (k: string) => `sim-${k}-${crypto.createHash("sha256").update(k + i.beneficiary.orgId + i.amount).digest("hex").slice(0, 10)}`;
  const checks: ComplianceResult["checks"] = [];
  checks.push({ kind: "kyb", result: i.beneficiary.kybVerified ? "pass" : "fail", detail: i.beneficiary.kybVerified ? "Beneficiary KYB verified" : "Beneficiary KYB not verified", providerRef: ref("kyb") });
  const nameHit = SANCTIONED_NAMES.some((n) => n.toLowerCase() === i.beneficiary.name.toLowerCase());
  checks.push({ kind: "sanctions", result: nameHit ? "fail" : "pass", detail: nameHit ? "Name match on simulated OFAC SDN list" : "No name match on sanctions lists", providerRef: ref("sanctions") });
  let travelRule: Record<string, unknown> | undefined;
  if (i.rail === "usdc") {
    const w = (i.beneficiary.wallet ?? "").toLowerCase();
    const ofacHit = SANCTIONED_WALLETS.some((s) => s.toLowerCase() === w);
    checks.push({ kind: "ofac_wallet", result: !w || ofacHit ? "fail" : "pass", detail: !w ? "No wallet on file" : ofacHit ? `Wallet ${i.beneficiary.wallet} is on the simulated OFAC SDN digital currency address list` : "Wallet not on OFAC list", providerRef: ref("ofac") });
    const kytHit = HIGH_RISK_KYT.some((s) => s.toLowerCase() === w);
    const kytScore = ofacHit || kytHit ? 92 : 8;
    checks.push({ kind: "kyt", result: kytScore >= 75 ? "fail" : "pass", detail: `KYT risk score ${kytScore} of 100 (simulated chain analytics)`, providerRef: ref("kyt") });
    travelRule = {
      standard: "IVMS101", amount: i.amount, asset: "USDC", chain: "base-sim", aboveThreshold: i.amount >= TRAVEL_RULE_THRESHOLD_USD,
      originator: { legalPerson: i.originator.name, id: i.originator.orgId, country: i.originator.country, wallet: i.originator.wallet ?? "treasury-mpc-wallet-sim" },
      beneficiary: { legalPerson: i.beneficiary.name, id: i.beneficiary.orgId, country: i.beneficiary.country, wallet: i.beneficiary.wallet },
      originatingVasp: "Platform custody partner (simulated)", beneficiaryVasp: "Supplier custody (simulated)",
    };
    checks.push({ kind: "travel_rule", result: "pass", detail: "Travel Rule record built for this stablecoin transfer", providerRef: ref("tr") });
  }
  const outcome = checks.some((c) => c.result === "fail") ? "blocked" : "clear";
  return { outcome, checks, travelRule };
}
