import crypto from "node:crypto";
import { isUsdc, type ComplianceResult, type Rail } from "@b2b/shared";
import { screenName, screenWallet, sdnStatus } from "./sdn.js";

/** Large transfer marker. A Travel Rule record is built for every stablecoin send regardless of amount. */
export const TRAVEL_RULE_THRESHOLD_USD = 3000;
/** Rule based KYT: a wallet with no outgoing transactions is new, and sends above this to it fail. */
export const KYT_NEW_WALLET_MAX_USD = 1000;

/** Wallet activity read from the chain (viem getTransactionCount on Base Sepolia). Null when the RPC could not be read. */
export type WalletActivity = { txCount: number; network: string; checkedAt: string } | null;

export type ComplianceInput = {
  intentId: string; rail: Rail; amount: number;
  /** The mandate per transaction cap. KYT fails when the amount is above it. */
  mandate: { id: string; perTxnMax: number };
  originator: { name: string; orgId: string; country: string; wallet?: string | null; custody?: string };
  beneficiary: {
    name: string; orgId: string; supplierId: string; country: string; wallet: string | null;
    /** From the supplier onboarding review in the DB, or the org KYB status for seeded suppliers. */
    kyb: { status: string; source: "onboarding review" | "org record"; reviewedBy?: string | null; reviewedAt?: string | null };
  };
  walletActivity?: WalletActivity;
};

const h = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 10);
const listDate = (fetchedAt: string | null) => (fetchedAt && /^\d{4}-\d{2}-\d{2}/.test(fetchedAt) ? fetchedAt.slice(0, 10).replace(/-/g, "") : fetchedAt ?? "unknown");

/** Screening against the local OFAC SDN download, the DB KYB status and a rule based KYT. Deterministic for the same inputs. */
export function screen(i: ComplianceInput): ComplianceResult {
  const list = sdnStatus();
  const ofacRef = (subject: string) => `ofac-sdn-${listDate(list.fetchedAt)}-${h(subject.toLowerCase())}`;
  const checks: ComplianceResult["checks"] = [];

  const k = i.beneficiary.kyb; const kybOk = k.status === "verified";
  checks.push({
    kind: "kyb", result: kybOk ? "pass" : "fail",
    detail: `Supplier ${k.source} status ${k.status}${k.reviewedBy ? `, reviewed by ${k.reviewedBy}` : ""}${k.reviewedAt ? ` on ${k.reviewedAt.slice(0, 10)}` : ""}`,
    providerRef: `kyb-${i.beneficiary.supplierId}-${k.status}`,
  });

  const nameHits = screenName(i.beneficiary.name); const hits: NonNullable<ComplianceResult["hits"]> = [...nameHits];
  checks.push({
    kind: "sanctions", result: !list.loaded || nameHits.length ? "fail" : "pass",
    detail: !list.loaded ? "OFAC SDN list not downloaded. Run npm run sdn:fetch" : nameHits.length ? `Name match on ${nameHits.map((x) => `${x.source} ${x.sdnName}`).join(", ")}` : `No name match on the OFAC SDN list of ${list.fetchedAt?.slice(0, 10) ?? "unknown date"} (${list.entries} entries)`,
    providerRef: ofacRef(i.beneficiary.name),
  });

  let travelRule: Record<string, unknown> | undefined;
  // A party whose wallet on file is OFAC listed is blocked on every rail, not only on stablecoin.
  if (!isUsdc(i.rail) && i.beneficiary.wallet) {
    const fiatHits = screenWallet(i.beneficiary.wallet.toLowerCase());
    if (fiatHits.length) {
      hits.push(...fiatHits);
      checks.push({ kind: "ofac_wallet", result: "fail", detail: `Supplier wallet on file ${i.beneficiary.wallet} is on the ${fiatHits.map((x) => x.source).join(" and ")} digital currency address list, so the party is blocked on every rail`, providerRef: ofacRef(i.beneficiary.wallet.toLowerCase()) });
    }
  }
  if (isUsdc(i.rail)) {
    const w = (i.beneficiary.wallet ?? "").toLowerCase();
    const wHits = screenWallet(w); hits.push(...wHits); const ofacHit = wHits.length > 0;
    checks.push({
      kind: "ofac_wallet", result: !w || !list.loaded || ofacHit ? "fail" : "pass",
      detail: !w ? "No wallet on file" : !list.loaded ? "OFAC SDN list not downloaded. Run npm run sdn:fetch" : ofacHit ? `Wallet ${i.beneficiary.wallet} is on the ${wHits.map((x) => x.source).join(" and ")} digital currency address list` : `Wallet not on the OFAC SDN digital currency address list (${list.addresses} addresses)`,
      providerRef: ofacRef(w || "no-wallet"),
    });

    // No chain analytics vendor is connected, so KYT is explicit rules on real inputs.
    const rules: string[] = []; let fail = false;
    if (ofacHit) { fail = true; rules.push("wallet is on the OFAC list"); } else rules.push("wallet not on the OFAC list");
    if (i.amount > i.mandate.perTxnMax) { fail = true; rules.push(`amount ${i.amount} above the mandate per transaction cap ${i.mandate.perTxnMax}`); } else rules.push(`amount within mandate cap ${i.mandate.perTxnMax}`);
    const a = i.walletActivity;
    if (!a) rules.push("wallet tx count unavailable, RPC not reachable");
    else if (a.txCount === 0 && i.amount > KYT_NEW_WALLET_MAX_USD) { fail = true; rules.push(`new wallet with 0 outgoing transactions on ${a.network}, amount above ${KYT_NEW_WALLET_MAX_USD}`); }
    else rules.push(`${a.txCount} outgoing transactions on ${a.network}${a.txCount === 0 ? " (new wallet)" : ""}`);
    checks.push({ kind: "kyt", result: fail ? "fail" : "pass", detail: `Rule based KYT: ${rules.join(", ")}`, providerRef: `kyt-rules-${h(`${w}|${i.amount}|${i.mandate.id}|${a?.txCount ?? "na"}`)}` });

    travelRule = {
      standard: "IVMS101", ref: `tr-${i.intentId}`, intentId: i.intentId, amount: i.amount, asset: "USDC",
      chain: i.rail === "circle_usdc" ? "BASE-SEPOLIA via Circle" : "base-sepolia", aboveThreshold: i.amount >= TRAVEL_RULE_THRESHOLD_USD,
      originator: { legalPerson: i.originator.name, id: i.originator.orgId, country: i.originator.country, wallet: i.originator.wallet ?? null, originatorPersons: [{ legalPerson: { name: i.originator.name, nationalIdentification: { id: i.originator.orgId, type: "platform org id" }, countryOfRegistration: i.originator.country } }], accountNumber: [i.originator.wallet ?? null] },
      beneficiary: { legalPerson: i.beneficiary.name, id: i.beneficiary.orgId, country: i.beneficiary.country, wallet: i.beneficiary.wallet, beneficiaryPersons: [{ legalPerson: { name: i.beneficiary.name, nationalIdentification: { id: i.beneficiary.orgId, type: "platform org id" }, countryOfRegistration: i.beneficiary.country } }], accountNumber: [i.beneficiary.wallet] },
      originatingVasp: i.originator.custody ?? (i.rail === "circle_usdc" ? "Circle developer controlled wallet" : "Platform self custody wallet"),
      beneficiaryVasp: "Unhosted supplier wallet",
    };
    checks.push({ kind: "travel_rule", result: "pass", detail: "IVMS101 record built from the payment, buyer and supplier records", providerRef: `tr-${i.intentId}` });
  }
  const outcome = checks.some((c) => c.result === "fail") ? "blocked" : "clear";
  return { outcome, checks, travelRule, hits };
}
