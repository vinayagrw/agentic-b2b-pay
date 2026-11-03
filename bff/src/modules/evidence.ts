import crypto from "node:crypto";
import type { EvidenceRecord } from "./store.js";

export const GENESIS = "0".repeat(64);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
}
/** Append only, hash chained. hash = sha256(prevHash | seq | subject | event | payloadHash | createdAt). */
export function appendEvidence(chain: EvidenceRecord[], subjectType: string, subjectId: string, event: string, payload: unknown): EvidenceRecord {
  const prev = chain[chain.length - 1];
  const seq = (prev?.seq ?? 0) + 1;
  const payloadHash = sha(canonical(payload));
  const createdAt = new Date().toISOString();
  const prevHash = prev?.hash ?? GENESIS;
  const hash = sha([prevHash, seq, subjectType, subjectId, event, payloadHash, createdAt].join("|"));
  const rec: EvidenceRecord = { id: `ev-${seq}`, seq, subjectType, subjectId, event, payload, payloadHash, prevHash, hash, createdAt };
  chain.push(rec);
  return rec;
}
export function verifyChain(chain: EvidenceRecord[]): { valid: boolean; brokenAt: number | null } {
  let prevHash = GENESIS;
  for (const r of chain) {
    const ph = sha(canonical(r.payload));
    const h = sha([prevHash, r.seq, r.subjectType, r.subjectId, r.event, ph, r.createdAt].join("|"));
    if (r.prevHash !== prevHash || r.payloadHash !== ph || r.hash !== h) return { valid: false, brokenAt: r.seq };
    prevHash = r.hash;
  }
  return { valid: true, brokenAt: null };
}
