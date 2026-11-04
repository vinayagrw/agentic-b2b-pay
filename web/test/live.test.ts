import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { arcPath, confidenceTone, confidenceWord, groupOf, mergeActivity, preview, railMix, slices, spendByStatus, type ActivityItem } from "../src/lib/live";
import { ConfidenceBar, ConfidenceList } from "../src/components/ConfidenceBar";

const intents = [
  { id: "p1", status: "settled", amount: 100, rail: "stripe_ach", invoiceId: "i1" },
  { id: "p2", status: "failed", amount: 50, rail: "circle_usdc", invoiceId: "i1" },
  { id: "p3", status: "blocked", amount: 25, route: { rail: null }, invoiceId: "i2" },
  { id: "p4", kind: "refund", status: "settled", amount: 10, rail: "stripe_ach", invoiceId: "i1" },
];

describe("confidence bar", () => {
  it("maps values to tone and word", () => {
    expect(confidenceTone(80)).toBe("ok"); expect(confidenceTone(50)).toBe("warn"); expect(confidenceTone(10)).toBe("bad"); expect(confidenceTone(null)).toBe("neutral");
    expect(confidenceWord(null)).toBe("No data");
  });
  it("renders a meter with value and basis", () => {
    const html = renderToStaticMarkup(h(ConfidenceBar, { c: { key: "risk", label: "Risk", value: 72, basis: "Risk score 28 of 100" } }));
    expect(html).toContain('role="meter"'); expect(html).toContain('aria-valuenow="72"'); expect(html).toContain("width:72%"); expect(html).toContain("Risk score 28 of 100");
    const none = renderToStaticMarkup(h(ConfidenceList, { items: [{ key: "match", label: "Invoice match", value: null, basis: "No match yet" }] }));
    expect(none).toContain("No data");
  });
});

describe("home charts", () => {
  it("groups payment mix by rail without refunds", () => {
    const m = railMix(intents as any);
    expect(m.map((r) => r.rail)).toEqual(["stripe_ach", "circle_usdc", "none"]); expect(m[0].amount).toBe(100);
  });
  it("splits supplier spend by status", () => {
    const rows = spendByStatus(intents as any, [{ id: "i1", supplierId: "s1" }, { id: "i2", supplierId: "s2" }], [{ id: "s1", name: "Acme" }, { id: "s2", name: "Bolt" }]);
    expect(rows[0]).toMatchObject({ supplier: "Acme", total: 150, settled: 100, failed: 50 }); expect(rows[1].blocked).toBe(25);
    expect(groupOf("submitted")).toBe("in_flight"); expect(groupOf("denied")).toBe("blocked");
  });
  it("builds donut slices that close the circle", () => {
    const s = slices([1, 1, 2]); expect(s.at(-1)!.to).toBeCloseTo(1); expect(s[2].share).toBe(0.5);
    expect(arcPath(0, 0.25, 50, 30)).toMatch(/^M .* A 50 50 0 0 1 .* Z$/);
  });
});

describe("activity and payloads", () => {
  const a = (seq: number): ActivityItem => ({ id: `e${seq}`, seq, at: "2026-11-04T10:00:00Z", kind: "payment", event: "x", title: "X", subjectId: "p", paymentId: null });
  it("merges newest first without duplicates and caps", () => {
    expect(mergeActivity([a(1), a(2)], [a(3), a(2)]).map((x) => x.seq)).toEqual([3, 2, 1]);
    expect(mergeActivity([a(1), a(2)], [a(3)], 2)).toHaveLength(2);
  });
  it("previews collapsed JSON nodes", () => {
    expect(preview({ a: 1, b: 2 })).toBe("{2 keys}"); expect(preview([1])).toBe("[1 item]"); expect(preview(null)).toBe("null"); expect(preview("x".repeat(80))).toContain("...");
  });
});
