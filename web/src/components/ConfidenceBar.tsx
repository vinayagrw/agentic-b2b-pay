import { Gauge } from "lucide-react";
import { cn } from "../lib/utils";
import { confidenceTone, confidenceWord, type Confidence } from "../lib/live";

const FILL = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", neutral: "bg-border" } as const;
const TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad", neutral: "text-muted" } as const;

/** One confidence reading as a bar with its value, word and the stored inputs behind it. */
export function ConfidenceBar({ c, compact }: { c: Confidence; compact?: boolean }) {
  const tone = confidenceTone(c.value); const v = c.value ?? 0;
  return <div className="min-w-0" data-testid={`confidence-${c.key}`}>
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="font-medium">{c.label}</span>
      <span className={cn("tabular-nums", TEXT[tone])}>{c.value === null ? "No data" : `${c.value} ${confidenceWord(c.value)}`}</span>
    </div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle" role="meter" aria-label={`${c.label} confidence`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.value ?? undefined} aria-valuetext={c.value === null ? "No data" : `${c.value} of 100`}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", FILL[tone])} style={{ width: `${v}%` }} />
    </div>
    {!compact && <p className="mt-1 text-[11px] leading-snug text-muted">{c.basis}</p>}
  </div>;
}

/** Match, route and risk confidence side by side. */
export function ConfidenceList({ items, compact, className }: { items: Confidence[]; compact?: boolean; className?: string }) {
  if (!items.length) return null;
  return <div className={cn("rounded-lg border border-border p-2.5", className)}>
    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium"><Gauge size={13} aria-hidden className="text-primary" />Confidence</div>
    <div className="grid gap-3 sm:grid-cols-3">{items.map((c) => <ConfidenceBar key={c.key} c={c} compact={compact} />)}</div>
  </div>;
}
