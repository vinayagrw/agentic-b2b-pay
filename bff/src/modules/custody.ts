import crypto from "node:crypto";

/** Simulated MPC custody: 2 of 3 approver quorum must co-sign before a stablecoin send is released. */
export const SIGNERS = [
  { id: "signer-treasury-ops", role: "Treasury ops" },
  { id: "signer-controller", role: "Controller" },
  { id: "signer-policy-engine", role: "Policy engine (automated co-signer)" },
];
export const QUORUM = 2;
export type CustodyResult = { approved: boolean; quorum: number; shares: { signer: string; role: string; partialSig: string }[]; aggregateSig: string | null };

export function mpcSign(txDigest: string, approvers: string[]): CustodyResult {
  const valid = SIGNERS.filter((s) => approvers.includes(s.id));
  const shares = valid.map((s) => ({ signer: s.id, role: s.role, partialSig: crypto.createHmac("sha256", s.id).update(txDigest).digest("hex").slice(0, 32) }));
  const approved = shares.length >= QUORUM;
  const aggregateSig = approved ? crypto.createHash("sha256").update(shares.map((x) => x.partialSig).join("")).digest("hex") : null;
  return { approved, quorum: QUORUM, shares, aggregateSig };
}
