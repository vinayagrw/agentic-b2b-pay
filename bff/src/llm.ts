import { spawn } from "node:child_process";
import os from "node:os";

export type LlmResult = { text: string | null; mode: "live" | "mock"; error?: string; ms: number };
export const llmMode = () => (process.env.LLM_MODE === "live" ? "live" : "mock");

/** Spawns the local claude CLI: claude -p <prompt> --output-format json, parses .result. Null text means use fallback. */
export function callClaude(prompt: string, timeoutMs = 60_000, extraArgs: string[] = []): Promise<LlmResult> {
  const t0 = Date.now();
  if (llmMode() !== "live") return Promise.resolve({ text: null, mode: "mock", ms: 0 });
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const finish = (r: Omit<LlmResult, "ms" | "mode">) => { if (done) return; done = true; resolve({ ...r, mode: "live", ms: Date.now() - t0 }); };
    let child;
    try {
      child = spawn(process.env.CLAUDE_BIN ?? "claude", ["-p", prompt, "--output-format", "json", ...extraArgs, ...(process.env.CLAUDE_MODEL ? ["--model", process.env.CLAUDE_MODEL] : [])], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { return finish({ text: null, error: String(e) }); }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ text: null, error: "timeout" }); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); finish({ text: null, error: `spawn failed: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ text: null, error: `exit ${code}: ${err.slice(0, 200)}` });
      try {
        const j = JSON.parse(out);
        if (j.is_error) return finish({ text: null, error: String(j.result ?? "is_error") });
        finish({ text: String(j.result ?? "") });
      } catch (e) { finish({ text: null, error: `bad json: ${String(e)}` }); }
    });
  });
}

export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no json object");
  return JSON.parse(body.slice(a, b + 1));
}
/** UI text rule: no em dashes, no semicolons. */
export const cleanText = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/;/g, ",").trim();
