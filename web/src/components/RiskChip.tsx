import { cn } from "../lib/utils";

const TONE = { low: "bg-ok/10 text-ok", medium: "bg-warn/15 text-warn", high: "bg-bad/10 text-bad" } as const;
/** Risk score chip. The level is written out so colour is never the only signal. */
export function RiskChip({ score, level, large }: { score?: number | null; level?: "low" | "medium" | "high" | null; large?: boolean }) {
  if (score == null || !level) return null;
  return <span title={`Risk score ${score} of 100`} className={cn("inline-flex items-center gap-1 rounded-full font-medium tabular-nums", TONE[level], large ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-[11px]")}>Risk {score}<span className="font-normal">{level}</span></span>;
}
