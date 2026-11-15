import { describe, expect, it } from "vitest";
import { landedCost, TARIFF_NOTE, type PoLine } from "@b2b/shared";
import { dutyLineText } from "../src/pages/flows";

const line: PoLine = { sku: "NW-DRV-750", description: "Servo drive", qty: 4, unitPrice: 420, hsCode: "8504.40", originCountry: "CN", dutyRatePct: 25, customsEntryDate: "2027-01-22", exclusionApplies: true, exclusionEndDate: "2027-01-09" };

describe("duty line and landed cost on the PO page", () => {
  it("adds duty to the goods total", () => {
    expect(landedCost([line])).toEqual({ goods: 1680, duty: 420, landed: 2100, hasDuty: true });
    expect(landedCost([{ ...line, customsEntryDate: "2027-01-09" }]).duty).toBe(0);
    expect(landedCost([{ sku: "X", description: "x", qty: 1, unitPrice: 5 }])).toEqual({ goods: 5, duty: 0, landed: 5, hasDuty: false });
  });
  it("describes a duty line in plain words", () => {
    const t = dutyLineText(line);
    expect(t).toContain("HS code 8504.40."); expect(t).toContain("Origin CN."); expect(t).toContain("Duty rate 25 percent."); expect(t).toContain("Customs entry 2027-01-22."); expect(t).toContain("Exclusion ended 2027-01-09");
    expect(dutyLineText({ ...line, customsEntryDate: "2026-12-18" })).toContain("Exclusion applies to 2027-01-09, so no duty is due");
    expect(dutyLineText({ ...line, exclusionApplies: false })).toContain("No exclusion.");
    expect(t).not.toMatch(/[—;]/); expect(TARIFF_NOTE).toBe("Duty rates are entered by you. No live tariff feed.");
  });
});
