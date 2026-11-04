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

/** Streams the claude CLI with stream-json and partial messages. onDelta gets each text delta. Aborting the signal kills the child. */
export function streamClaude(prompt: string, onDelta: (t: string) => void, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LlmResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let buf = "", err = "", text = "", final: string | null = null, isErr = false, done = false;
    const finish = (r: Omit<LlmResult, "ms" | "mode">) => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); resolve({ ...r, mode: "live", ms: Date.now() - t0 }); };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(process.env.CLAUDE_BIN ?? "claude", ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...(process.env.CLAUDE_MODEL ? ["--model", process.env.CLAUDE_MODEL] : [])], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolve({ text: null, mode: "live", error: String(e), ms: 0 }); }
    const onAbort = () => { child.kill("SIGKILL"); finish({ text: null, error: "aborted" }); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ text: null, error: "timeout" }); }, opts.timeoutMs ?? 60_000);
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const line = (l: string) => { if (!l.trim()) return; try { const j = JSON.parse(l);
      if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") { const d = String(j.event.delta.text ?? ""); text += d; if (d && !done) onDelta(d); }
      else if (j.type === "result") { final = j.result === undefined ? null : String(j.result); isErr = !!j.is_error; } } catch { /* skip non json lines */ } };
    child.stdout!.on("data", (d) => { buf += d; const ls = buf.split("\n"); buf = ls.pop() ?? ""; ls.forEach(line); });
    child.stderr!.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ text: null, error: `spawn failed: ${e.message}` }));
    child.on("close", (code) => { line(buf); if (code !== 0) return finish({ text: null, error: `exit ${code}: ${err.slice(0, 200)}` }); if (isErr) return finish({ text: null, error: String(final ?? "is_error") }); finish({ text: final ?? (text || null) }); });
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
