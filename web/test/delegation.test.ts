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

import { delegationLine, handledForBadge } from "../src/lib/delegation";
describe("hand over card helpers", () => {
  const d = { id: "d1", fromUser: "a", fromName: "Ann", toUser: "b", toName: "Bo", startsOn: "2026-11-01", endsOn: "2026-11-09", note: "", state: "active" as const };
  it("describes the hand over from the viewer side", () => {
    expect(delegationLine(d, "a")).toBe("You to Bo, 2026-11-01 to 2026-11-09");
    expect(delegationLine(d, "b")).toBe("Ann to you, 2026-11-01 to 2026-11-09");
    expect(delegationLine({ ...d, note: "Leave" }, "c")).toBe("Ann to Bo, 2026-11-01 to 2026-11-09. Leave");
  });
  it("badges only pending cards handled for someone else", () => {
    expect(handledForBadge({ status: "pending_approval", delegatedFrom: { userId: "a", name: "Ann" } })).toBe("Approving for Ann");
    expect(handledForBadge({ status: "approved", delegatedFrom: { userId: "a", name: "Ann" } })).toBeNull();
    expect(handledForBadge({ status: "pending_approval", delegatedFrom: null })).toBeNull();
  });
});
