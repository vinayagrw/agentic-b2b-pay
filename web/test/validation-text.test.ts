import { describe, expect, it } from "vitest";
import { validationText } from "../src/lib/errors";

describe("validation errors in plain words", () => {
  it("explains an empty list of invoice lines", () => {
    const t = validationText({ error: "validation", issues: [{ code: "too_small", type: "array", minimum: 1, path: ["lines"], message: "Array must contain at least 1 element(s)" }] });
    expect(t).not.toBe("validation"); expect(t).toMatch(/at least one item line/i);
  });
  it("names other fields in words", () => {
    const t = validationText({ error: "validation", issues: [{ code: "invalid_type", path: ["amount"], message: "Expected number, received string" }] });
    expect(t).toMatch(/amount/); expect(t).toMatch(/^Check/);
  });
  it("passes non-validation errors through", () => {
    expect(validationText({ error: "Invoice is on hold" })).toBe("Invoice is on hold");
  });
});
