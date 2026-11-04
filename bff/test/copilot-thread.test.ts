import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { reset } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as CP from "../src/copilot.js";
import * as P from "../src/platform.js";
import { streamClaude } from "../src/llm.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); });
const ctx = (id: string, scope: string | null): CP.Ctx => ({ user: P.getUser(id)!, scope, prefix: scope ? "/app" : "/operator" });

describe("copilot thread context and abort (mock mode)", () => {
  it("a short follow-up reuses the thread context and previous tools", async () => {
    const jane = ctx("usr-cfo-jane", "tnt-acme");
    const a = await CP.ask(jane, "Who are our top suppliers by spend?");
    const steps: any[] = [];
    const b = await CP.ask(jane, "and last month?", (s) => steps.push(s), { threadId: a.threadId });
    expect(b.threadId).toBe(a.threadId);
    expect(b.tools.map((t) => t.tool)).toEqual(a.tools.map((t) => t.tool));
    expect(steps[0].data.context).toBe(1);
    expect(CP.threadTurns(jane.user, a.threadId).map((t) => t.question)).toEqual([a.question, b.question]);
    const lone = await CP.ask(jane, "and last month?");
    expect(lone.refused).toBeTruthy();
  });
  it("an aborted ask stops and stores nothing", async () => {
    const jane = ctx("usr-cfo-jane", "tnt-acme"); const ac = new AbortController(); ac.abort();
    await expect(CP.ask(jane, "Who are our top suppliers by spend?", undefined, { signal: ac.signal })).rejects.toThrow(/stopped/);
    expect(CP.listThreads(jane.user)).toEqual([]);
  });
  describe("streamClaude", () => {
    const bin = process.env.CLAUDE_BIN;
    afterEach(() => { if (bin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = bin; });
    it("forwards deltas and kills the child on abort", async () => {
      process.env.CLAUDE_BIN = path.join(__dirname, "fixtures", "slow-claude.mjs");
      const ac = new AbortController(); const got: string[] = [];
      const r = await streamClaude("x", (t) => { got.push(t); ac.abort(); }, { signal: ac.signal, timeoutMs: 5000 });
      expect(got).toEqual(["Hello "]); expect(r.error).toBe("aborted"); expect(r.ms).toBeLessThan(4000);
    });
  });
});
