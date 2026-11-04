import { ClipboardList, GitCommitVertical } from "lucide-react";
import { useGet } from "../lib/api";
import { Card } from "./ui";
import { EmptyState, Skeleton, StatusDot, toneOf } from "./kit";
import { buildTrace, gap } from "./trace";

const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

/** Lifecycle and audit events for one payment on a single time axis. */
export function TraceTimeline({ id }: { id: string }) {
  const { data, error } = useGet<any>(`/payments/${id}`, !!id);
  const rows = data ? buildTrace(data.intent?.timeline, data.evidence) : [];
  return <Card title="Trace" action={<span className="flex gap-3"><StatusDot tone="primary" label="Lifecycle" /><StatusDot tone="neutral" label="Audit" /></span>}>
    {error ? <EmptyState title="Trace not available" body={(error as Error).message} /> : !data ? <Skeleton lines={5} /> : !rows.length ? <EmptyState icon={ClipboardList} title="No events yet" body="Status changes and audit records show here as the payment moves." /> :
      <ol className="relative ml-2 border-l border-border" aria-label={`Trace for payment ${id}`}>{rows.map((r, n) => <li key={n} className="mb-3 ml-4 last:mb-0">
        <span aria-hidden className={r.kind === "lifecycle" ? "absolute -left-[7px] mt-1 grid h-3.5 w-3.5 place-items-center rounded-full border-2 border-surface bg-primary" : "absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border border-surface bg-muted"} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {r.kind === "lifecycle" ? <StatusDot tone={toneOf(r.status ?? "")} label={<span className="text-[13px] font-medium text-fg">{r.title}</span>} /> : <span className="flex items-center gap-1 text-[13px]"><GitCommitVertical size={13} aria-hidden className="text-muted" />{r.title}</span>}
          <time dateTime={r.at} className="text-xs tabular-nums text-muted">{fmt(r.at)}</time>
          {n > 0 && gap(rows[n - 1].at, r.at) && <span className="text-[11px] text-muted">{gap(rows[n - 1].at, r.at)}</span>}
          {r.source && <span className="text-[11px] text-muted">by {r.source}</span>}
        </div>
        {r.detail && <div className="text-xs text-muted">{r.detail}</div>}
      </li>)}</ol>}
  </Card>;
}
