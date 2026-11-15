import { describe, expect, it } from "vitest";
import { delegationBlock, resubmitBlock, DELEGATION_STATE } from "../src/lib/delegation";

describe("approval hand over", () => {
  const ok = { toUserId: "usr-lee", startsOn: "2026-11-15", endsOn: "2026-11-20" };
  it("checks the form like the server does", () => {
    expect(delegationBlock(ok, "usr-jane", "2026-11-15")).toBeNull();
    expect(delegationBlock({ ...ok, toUserId: "" }, "usr-jane", "2026-11-15")).toMatch(/Pick who/);
    expect(delegationBlock(ok, "usr-lee", "2026-11-15")).toMatch(/yourself/);
    expect(delegationBlock({ ...ok, endsOn: "2026-11-10" }, "usr-jane", "2026-11-15")).toMatch(/on or after/);
    expect(delegationBlock({ ...ok, startsOn: "2026-11-01", endsOn: "2026-11-02" }, "usr-jane", "2026-11-15")).toMatch(/past/);
    expect(delegationBlock({ ...ok, endsOn: "2027-06-01" }, "usr-jane", "2026-11-15")).toMatch(/90 days/);
  });
  it("has plain words for each state", () => { expect(DELEGATION_STATE.revoked.text).toBe("Stopped"); });
});
describe("resubmit", () => {
  it("needs a rejected order, the requester and a note", () => {
    expect(resubmitBlock({ status: "rejected", canResubmit: true }, "Fewer units")).toBeNull();
    expect(resubmitBlock({ status: "approved", canResubmit: true }, "x y z")).toMatch(/rejected/);
    expect(resubmitBlock({ status: "rejected", canResubmit: false }, "Fewer units")).toMatch(/asked for/);
    expect(resubmitBlock({ status: "rejected", canResubmit: true }, " ")).toMatch(/what changed/);
  });
});
