import { describe, expect, it } from "vitest";
import { contrast, luminance, meetsAA, parseHex, readableOn, themeVars } from "../src/lib/theme";
import { buildTrace, gap, routeView } from "../src/components/trace";
import { appendBounded, parseData } from "../src/lib/stream";
import { can, canAny } from "../src/lib/perm";

describe("theme contrast", () => {
  it("parses short and long hex", () => { expect(parseHex("#fff")).toEqual([255, 255, 255]); expect(parseHex("1d4ed8")).toEqual([29, 78, 216]); expect(parseHex("nope")).toBeNull(); });
  it("matches WCAG reference values", () => { expect(luminance("#ffffff")).toBeCloseTo(1); expect(contrast("#000000", "#ffffff")).toBeCloseTo(21); });
  it("picks a readable text colour for every bank colour", () => {
    for (const bg of ["#1d4ed8", "#f59e0b", "#ffffff", "#000000", "#00a651", "#ffcc00", "#7c3aed", "#e11d48"]) {
      const fg = readableOn(bg); expect(meetsAA(fg, bg, true)).toBe(true);
    }
    expect(readableOn("#1d4ed8")).toBe("#ffffff"); expect(readableOn("#ffcc00")).not.toBe("#ffffff");
  });
  it("exposes derived fg variables", () => { const v = themeVars({ primary: "#1d4ed8", accent: "#f59e0b" }); expect(v["--brand-primary-fg"]).toBe("#ffffff"); expect(v["--brand-accent-fg"]).toBeDefined(); });
});

describe("trace", () => {
  it("merges lifecycle and audit rows in time order without duplicates", () => {
    const t = buildTrace([{ at: "2026-01-01T00:00:02Z", status: "settled" }, { at: "2026-01-01T00:00:00Z", status: "created" }, { at: "2026-01-01T00:00:00Z", status: "created" }], [{ event: "payment.routed", createdAt: "2026-01-01T00:00:01Z" }]);
    expect(t.map((r) => r.title)).toEqual(["created", "payment routed", "settled"]);
  });
  it("formats gaps", () => { expect(gap("2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z")).toBe("2 min later"); expect(gap("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(""); });
  it("classifies router options, chosen first", () => {
    const v = routeView([{ rail: "stripe_card", eligible: true, feeUsd: 30, settleMinutes: 2, score: 50, why: [] }, { rail: "stripe_ach", eligible: true, feeUsd: 1, settleMinutes: 2880, score: 60, why: [] }, { rail: "circle_usdc", eligible: false, feeUsd: 0, settleMinutes: 1, score: 0, why: ["No supplier wallet on file"] }], "stripe_ach");
    expect(v.map((x) => x.kind)).toEqual(["chosen", "eligible", "ineligible"]); expect(v[2].verdict).toContain("No supplier wallet");
  });
});

describe("stream and permissions", () => {
  it("parses JSON data and keeps text", () => { expect(parseData('{"a":1}')).toEqual({ a: 1 }); expect(parseData("hello")).toBe("hello"); expect(parseData("{bad")).toBe("{bad"); });
  it("bounds the buffer", () => { expect(appendBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4]); });
  it("checks permissions", () => { const me = { permissions: ["workspace.read"] }; expect(can(me, "workspace.read")).toBe(true); expect(can(me, "payments.approve")).toBe(false); expect(can(null, "x")).toBe(false); expect(canAny(me, ["x", "workspace.read"])).toBe(true); });
});

import { foldStream } from "../src/lib/copilot";
describe("copilot stream", () => {
  it("folds tool, token and done events", () => {
    const m = (event: string, data: any) => ({ event, data, at: 0 });
    const f = foldStream([m("status", { step: "planning" }), m("tool", { tool: "pendingApprovals", rows: 2, error: null }), m("token", { text: "Two " }), m("token", { text: "orders" })]);
    expect(f.text).toBe("Two orders"); expect(f.tools[0].rows).toBe(2); expect(f.done).toBeNull();
    const d = foldStream([m("done", { question: "q", answer: "Final", sources: [], proposals: [], mode: "mock" })]);
    expect(d.text).toBe("Final"); expect(d.step).toBe("done");
  });
});

import { stepUpNeeded } from "../src/lib/perm";
import { rateLimitText, toast, onToast } from "../src/lib/toast";
describe("step-up and rate limit UI logic", () => {
  it("asks for a code only above the threshold and when not fresh", () => {
    const s = { enrolled: true, thresholdUsd: 10000, fresh: false, freshUntil: null };
    expect(stepUpNeeded(10000, s)).toBe(false); expect(stepUpNeeded(10000.01, s)).toBe(true);
    expect(stepUpNeeded(50000, { ...s, fresh: true })).toBe(false); expect(stepUpNeeded(50000, undefined)).toBe(false);
  });
  it("words the 429 toast with Retry-After and delivers it to listeners", () => {
    expect(rateLimitText("12")).toBe("Too many requests. Wait 12 s and try again.");
    expect(rateLimitText(null)).toMatch(/Wait a moment/);
    const got: string[] = []; const off = onToast((t) => got.push(t.text)); toast("hi"); off(); toast("gone");
    expect(got).toEqual(["hi"]);
  });
});
