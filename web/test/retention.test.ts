import { describe, expect, it } from "vitest";
import { daysError, exportUrl, keepText, runSummary, verifyText } from "../src/lib/retention";

describe("retention helpers", () => {
  it("checks the days box", () => {
    expect(daysError("")).toBeNull(); expect(daysError("30")).toBeNull();
    expect(daysError("0")).toMatch(/whole number/); expect(daysError("2.5")).toMatch(/whole number/);
  });
  it("says what a policy keeps", () => { expect(keepText(null)).toBe("Keep forever"); expect(keepText(90)).toBe("Keep 90 days"); });
  it("sums a purge run", () => {
    expect(runSummary({ id: "p", ranAt: "", ranBy: "", removed: { events: 2, audit: 3, invoices: 0, payments: 1 }, skippedForHold: { events: 0, audit: 1, invoices: 0, payments: 2 } })).toBe("Removed 6 records, kept 3 on hold");
  });
  it("names the broken link", () => {
    const base = { brokenId: null, checked: 10, firstSeq: 1, lastSeq: 10, anchor: null };
    expect(verifyText({ ...base, valid: true, brokenAt: null, brokenEvent: null })).toMatch(/whole. Checked 10/);
    expect(verifyText({ ...base, valid: false, brokenAt: 3, brokenEvent: "po.created" })).toMatch(/broken at link 3 \(po.created\)/);
  });
  it("builds the export link", () => { expect(exportUrl("tnt-acme", "2026-11-01", "")).toBe("/api/ops/audit/export.jsonl?tenantId=tnt-acme&from=2026-11-01"); });
});
