export type RecordType = "events" | "audit" | "invoices" | "payments";
export type Policy = { recordType: RecordType; days: number | null; updatedBy: string | null; updatedAt: string | null };
export type Hold = { id: string; tenantId: string; caseId: string | null; reason: string; placedBy: string; placedAt: string; releasedBy: string | null; releasedAt: string | null };
export type PurgeRun = { id: string; ranAt: string; ranBy: string; removed: Record<RecordType, number>; skippedForHold: Record<RecordType, number> };
export type RetentionView = { policies: Policy[]; holds: Hold[]; runs: PurgeRun[]; anchor: { seq: number; hash: string; at: string } | null; mode: string };
export type VerifyResult = { valid: boolean; brokenAt: number | null; brokenId: string | null; brokenEvent: string | null; checked: number; firstSeq: number | null; lastSeq: number | null; anchor: { seq: number } | null };

export const TYPE_LABEL: Record<RecordType, string> = { events: "Webhook events", audit: "Audit chain", invoices: "Paid invoices", payments: "Finished payments" };
export const keepText = (days: number | null) => days == null ? "Keep forever" : days === 1 ? "Keep 1 day" : `Keep ${days} days`;
/** Null when the days box is fine. Empty means keep forever. */
export function daysError(v: string): string | null {
  if (v.trim() === "") return null;
  const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 36500 ? null : "Use a whole number from 1 to 36500, or leave it empty";
}
export const runSummary = (r: PurgeRun) => {
  const total = (x: Record<string, number>) => Object.values(x).reduce((a, b) => a + b, 0);
  const s = total(r.skippedForHold);
  return `Removed ${total(r.removed)} records${s ? `, kept ${s} on hold` : ""}`;
};
export const verifyText = (v: VerifyResult) => v.valid
  ? `Chain is whole. Checked ${v.checked} links${v.anchor ? ` from purge point ${v.anchor.seq}` : ""}.`
  : `Chain is broken at link ${v.brokenAt}${v.brokenEvent ? ` (${v.brokenEvent})` : ""}. Links after it cannot be trusted.`;
export function exportUrl(tenantId: string, from: string, to: string) {
  const q = new URLSearchParams({ tenantId }); if (from) q.set("from", from); if (to) q.set("to", to);
  return `/api/ops/audit/export.jsonl?${q}`;
}
