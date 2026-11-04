import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { TrendingDown, TrendingUp, X, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui";
export { EmptyState } from "./ui";

/** Placeholder block shown while data loads. */
export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines) return <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">{Array.from({ length: lines }, (_, n) => <div key={n} className={cn("skeleton h-4 rounded", n === lines - 1 && "w-2/3", className)} />)}</div>;
  return <div aria-hidden className={cn("skeleton h-4 rounded", className)} />;
}
/** Table shaped skeleton for list pages. */
export function SkeletonTable({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading rows">{Array.from({ length: rows }, (_, r) => <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>{Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={c === 0 ? "w-3/4" : ""} />)}</div>)}</div>;
}

export type Tone = "ok" | "bad" | "warn" | "neutral" | "primary";
const DOT: Record<Tone, string> = { ok: "bg-ok", bad: "bg-bad", warn: "bg-warn", neutral: "bg-muted", primary: "bg-primary" };
/** Small coloured dot with a text label, so colour is never the only signal. */
export function StatusDot({ tone, label, pulse, className }: { tone: Tone; label?: React.ReactNode; pulse?: boolean; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1.5 text-xs", className)}>
    <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", DOT[tone], pulse && "motion-safe:animate-pulse")} />{label}
  </span>;
}
export function toneOf(status: string): Tone {
  if (/settled|paid|approved|verified|active|matched|done|clear/.test(status)) return "ok";
  if (/blocked|denied|failed|rejected|flagged|exception/.test(status)) return "bad";
  if (/pending|submitted|waiting|routed|draft|running/.test(status)) return "warn";
  return "neutral";
}

/** Right hand panel for detail views. Focus is trapped and Escape closes it. */
export function SlidePanel({ open, onClose, title, description, width = 460, children, footer }: { open: boolean; onClose: () => void; title: React.ReactNode; description?: string; width?: number; children: React.ReactNode; footer?: React.ReactNode }) {
  return <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/30" />
      <D.Content style={{ maxWidth: width }} className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-xl outline-none">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3"><D.Title className="text-sm font-semibold">{title}</D.Title>
          <D.Close asChild><Button size="icon" variant="ghost" className="ml-auto" aria-label="Close"><X size={16} /></Button></D.Close></div>
        <D.Description className="sr-only">{description ?? "Detail panel"}</D.Description>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">{children}</div>
        {footer && <div className="border-t border-border px-5 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  </D.Root>;
}

/** KPI tile with an optional change against the previous period and a small trend slot. */
export function KpiCard({ label, value, hint, icon: Icon, delta, goodWhen = "up", trend }: { label: string; value: React.ReactNode; hint?: string; icon?: LucideIcon; delta?: number | null; goodWhen?: "up" | "down"; trend?: React.ReactNode }) {
  const good = delta == null || delta === 0 ? null : (delta > 0) === (goodWhen === "up");
  const Arrow = delta != null && delta < 0 ? TrendingDown : TrendingUp;
  return <div className="flex flex-col rounded-xl border border-border bg-surface p-4">
    <div className="flex items-center gap-2 text-muted">{Icon && <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary"><Icon size={16} aria-hidden /></span>}<span className="text-xs font-medium">{label}</span>
      {delta != null && <span className={cn("ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums", good === null ? "bg-subtle text-muted" : good ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad")}><Arrow size={11} aria-hidden />{delta > 0 ? "+" : ""}{delta} percent</span>}</div>
    <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>{hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    {trend && <div className="mt-2 h-10">{trend}</div>}
  </div>;
}

/** Percent change from the first half of a series to the second half. Null when there is nothing to compare. */
export function halfDelta(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mid = Math.floor(xs.length / 2); const a = xs.slice(0, mid).reduce((s, x) => s + x, 0); const b = xs.slice(mid).reduce((s, x) => s + x, 0);
  if (!a) return null;
  return Math.round(((b - a) / a) * 1000) / 10;
}
