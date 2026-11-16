import { describe, it, expect } from "vitest";
import { confirmStep } from "../src/lib/confirm";
import { viewNameRequest } from "../src/lib/views";

describe("inline confirm", () => {
  it("asks first, then runs only on yes", () => {
    expect(confirmStep("idle", "click")).toEqual({ state: "asking", run: false });
    expect(confirmStep("asking", "cancel")).toEqual({ state: "idle", run: false });
    expect(confirmStep("asking", "yes")).toEqual({ state: "idle", run: true });
    expect(confirmStep("idle", "yes")).toEqual({ state: "idle", run: false });
  });
});
describe("view name form", () => {
  it("needs a name and trims it", () => {
    expect(viewNameRequest("payments", "  ", { filter: "x" })).toEqual({ error: "Add a name." });
    expect(viewNameRequest("payments", " Late ACH ", { filter: "x" })).toEqual({ body: { table: "payments", name: "Late ACH", state: { filter: "x" } } });
  });
});
