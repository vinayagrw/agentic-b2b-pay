import { describe, it, expect, vi } from "vitest";
import { withStartupRetry, isStartupRetryable, ApiError, startupCall, isStarting, resetStarting, waitForReady } from "../src/lib/api";

const noWait = () => Promise.resolve();
describe("startup retry", () => {
  it("retries 500, 502, 503 and network errors only", () => {
    for (const s of [500, 502, 503]) expect(isStartupRetryable(new ApiError(s, "x"))).toBe(true);
    expect(isStartupRetryable(new TypeError("Failed to fetch"))).toBe(true);
    for (const s of [400, 401, 403, 404, 429]) expect(isStartupRetryable(new ApiError(s, "x"))).toBe(false);
  });
  it("keeps trying until the call works", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new ApiError(502, "x")).mockRejectedValueOnce(new TypeError("net")).mockResolvedValue("ok");
    expect(await withStartupRetry(fn, { sleep: noWait })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("does not retry a 401", async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError(401, "no"));
    await expect(withStartupRetry(fn, { sleep: noWait })).rejects.toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("gives up after the time budget", async () => {
    let t = 0; const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(new ApiError(503, "down"));
    await expect(withStartupRetry(fn, { budgetMs: 10_000, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } })).rejects.toMatchObject({ status: 503 });
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
    expect(waits[0]).toBeLessThan(waits[waits.length - 1] + 1);
    expect(fn.mock.calls.length).toBeGreaterThan(3);
  });
  it("only retries until the first startup call works", async () => {
    resetStarting();
    const ok = vi.fn().mockRejectedValueOnce(new ApiError(500, "x")).mockResolvedValue("ok");
    expect(await startupCall(ok, { sleep: noWait })).toBe("ok");
    expect(isStarting()).toBe(false);
    const late = vi.fn().mockRejectedValue(new ApiError(500, "boom"));
    await expect(startupCall(late, { sleep: noWait })).rejects.toThrow("boom");
    expect(late).toHaveBeenCalledTimes(1);
    resetStarting();
  });
  it("lets the stream open after the budget runs out even if ready fails", async () => {
    resetStarting();
    let t = 0;
    const down = vi.fn().mockRejectedValue(new ApiError(502, "x"));
    expect(await waitForReady(down, { budgetMs: 1000, now: () => t, sleep: async (ms) => { t += ms; } })).toBe(false);
    expect(isStarting()).toBe(true);
    expect(await waitForReady(() => Promise.resolve({}), { sleep: noWait })).toBe(true);
    resetStarting();
  });
});
