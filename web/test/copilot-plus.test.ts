import { describe, expect, it } from "vitest";
import { snapProblem, speechCtor, SNAP_MAX } from "../src/lib/copilot";

describe("snap upload check", () => {
  it("accepts images and PDFs up to 3 MB only", () => {
    expect(snapProblem({ type: "image/png", size: 10 })).toBe("");
    expect(snapProblem({ type: "application/pdf", size: SNAP_MAX })).toBe("");
    expect(snapProblem({ type: "text/html", size: 10 })).toMatch(/PNG/);
    expect(snapProblem({ type: "image/jpeg", size: SNAP_MAX + 1 })).toMatch(/3 MB/);
    expect(snapProblem({ type: "image/jpeg", size: 0 })).toMatch(/empty/);
  });
});
describe("voice", () => {
  it("is hidden when the browser has no speech recognition", () => { expect(speechCtor()).toBeNull(); });
});
