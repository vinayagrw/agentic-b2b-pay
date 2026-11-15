import { describe, expect, it } from "vitest";
import { can, noAccessText } from "../src/lib/perm";

describe("reconciliation access text", () => {
  it("approver lacks statements.read and gets plain words, not the permission key", () => {
    const approver = { permissions: ["payments.approve", "risk.review"] };
    expect(can(approver, "statements.read")).toBe(false);
    const t = noAccessText("statements.read");
    expect(t).not.toContain("statements.read");
    expect(t).toMatch(/cannot view bank statements/);
  });
  it("unknown permission falls back to a generic sentence", () => {
    expect(noAccessText("x.y")).toMatch(/cannot open this page/);
  });
});

describe("plain wording for permission errors from the server", () => {
  it("rewrites 'Role X does not include perm' into a plain sentence", async () => {
    const { plainForbidden } = await import("../src/lib/perm");
    const t = plainForbidden("Role approver does not include erp.vendor_master");
    expect(t).not.toMatch(/erp\.vendor_master|does not include/);
    expect(t).toMatch(/approver/); expect(t).toMatch(/Ask an admin/);
  });
  it("leaves other messages alone", async () => {
    const { plainForbidden } = await import("../src/lib/perm");
    expect(plainForbidden("Invoice is on hold: x")).toBe("Invoice is on hold: x");
  });
});
