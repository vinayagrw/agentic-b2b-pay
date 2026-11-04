import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can } from "../lib/perm";
import { usd } from "../lib/utils";
import { Badge, Button, Card, ErrorNote, Mono, Muted, PageHeader, Textarea } from "../components/ui";
import { SkeletonTable, SlidePanel, StatusDot, toneOf } from "../components/kit";
import { SmartTable } from "../components/TableKit";
import { RiskChip } from "../components/RiskChip";
import { Section } from "../components/Shell";

export type RiskRow = { paymentId: string; tenantId: string; supplier: string; amount: number; status: string; rail: string | null; createdAt: string | null; score: number; level: "low" | "medium" | "high"; reasons: { code: string; label: string; points: number; detail: string }[]; review: "open" | "cleared" | "escalated"; reviewReason: string | null; decidedBy: string | null; decidedAt: string | null };
const REVIEW_TONE = { open: "warn", cleared: "ok", escalated: "bad" } as const;

/** Payments the risk rules flagged. People with risk.review clear them with a reason or escalate them. */
export function RiskInboxPage() {
  const [status, setStatus] = useState("open");
  const { data, error } = useGet<RiskRow[]>(`/risk/inbox?status=${status}`);
  const { data: me } = useMe(); const [open, setOpen] = useState<RiskRow | null>(null);
  const prefix = location.pathname.startsWith("/operator") ? "/operator" : "/app";
  const cols = useMemo<ColumnDef<RiskRow>[]>(() => [
    { header: "Payment", accessorKey: "paymentId", cell: (c) => <Mono>{c.getValue<string>()}</Mono> },
    { header: "Score", accessorKey: "score", cell: (c) => <RiskChip score={c.row.original.score} level={c.row.original.level} /> },
    { header: "Supplier", accessorKey: "supplier" },
    { header: "Amount", accessorKey: "amount", cell: (c) => <span className="tabular-nums">{usd(c.getValue<number>())}</span> },
    { header: "Reasons", id: "reasons", enableSorting: false, accessorFn: (r) => r.reasons.map((x) => x.label).join(", "), cell: (c) => <span className="flex flex-wrap gap-1">{c.row.original.reasons.map((r) => <Badge key={r.code} v={r.label} tone="neutral" />)}</span> },
    { header: "Payment status", accessorKey: "status", cell: (c) => <StatusDot tone={toneOf(c.getValue<string>())} label={c.getValue<string>()} /> },
    { header: "Review", accessorKey: "review", cell: (c) => <StatusDot tone={REVIEW_TONE[c.row.original.review]} label={c.row.original.review} /> },
    { header: "Tenant", accessorKey: "tenantId", cell: (c) => <Muted>{c.getValue<string>()}</Muted> },
  ], []);
  return <Section>
    <PageHeader title="Risk inbox" sub="Payments scored 30 or more by the risk rules. Clear with a reason or escalate to compliance." actions={<div className="flex gap-1">{["open", "escalated", "cleared", "all"].map((s) => <Button key={s} size="sm" variant={status === s ? "primary" : "ghost"} onClick={() => setStatus(s)}>{s[0].toUpperCase() + s.slice(1)}</Button>)}</div>} />
    {error && <ErrorNote msg={(error as Error).message} />}
    <Card pad={false}>{!data ? <SkeletonTable cols={6} /> : <SmartTable table="risk" data={data} columns={cols} getId={(r) => r.paymentId} onRow={setOpen} extraState={{ status }} onExtraState={(s) => s.status && setStatus(s.status)}
      empty={<div className="flex flex-col items-center gap-2 px-6 py-12 text-center"><ShieldAlert size={20} className="text-muted" aria-hidden /><div className="text-sm font-medium">Nothing to review</div><Muted>Payments with a risk score of 30 or more land here.</Muted></div>} />}</Card>
    <SlidePanel open={!!open} onClose={() => setOpen(null)} title={open ? `Risk review ${open.paymentId}` : ""} description="Risk score, reasons and review decision">
      {open && <RiskDetail row={open} canReview={can(me, "risk.review")} prefix={prefix} onDone={() => setOpen(null)} />}
    </SlidePanel>
  </Section>;
}

function RiskDetail({ row, canReview, prefix, onDone }: { row: RiskRow; canReview: boolean; prefix: string; onDone: () => void }) {
  const { run, busy, error } = useAct(); const [reason, setReason] = useState("");
  const decide = async (action: "clear" | "escalate") => { const r = await run(() => api(`/risk/${row.paymentId}/decide`, { action, reason: reason.trim() })); if (r) onDone(); };
  return <>
    <div className="flex items-center gap-3"><RiskChip score={row.score} level={row.level} large /><div><div className="text-[13px]">{row.supplier}</div><div className="text-lg font-semibold tabular-nums">{usd(row.amount)}</div></div></div>
    <ul className="flex flex-col gap-2">{row.reasons.map((r) => <li key={r.code} className="rounded-lg border border-border p-2.5"><div className="flex items-center gap-2 text-[13px] font-medium">{r.label}<span className="ml-auto text-xs text-muted">+{r.points}</span></div><Muted>{r.detail}</Muted></li>)}</ul>
    {row.review !== "open" && <div className="rounded-lg bg-subtle p-3 text-xs"><StatusDot tone={REVIEW_TONE[row.review]} label={`${row.review} by ${row.decidedBy}`} /><p className="mt-1">"{row.reviewReason}"</p></div>}
    <Button asChild size="sm"><Link to={`${prefix}/payments/${row.paymentId}`}>Open transaction flow and Why panel</Link></Button>
    {canReview ? <div className="flex flex-col gap-2">
      <label htmlFor="risk-reason" className="text-xs font-medium text-muted">Reason (required)</label>
      <Textarea id="risk-reason" className="min-h-16 font-sans text-[13px]" placeholder="What you checked and why" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2"><Button variant="primary" className="h-11 flex-1 sm:h-8 sm:flex-none" disabled={busy || reason.trim().length < 3} onClick={() => decide("clear")}>Clear</Button><Button variant="danger" className="h-11 flex-1 sm:h-8 sm:flex-none" disabled={busy || reason.trim().length < 3} onClick={() => decide("escalate")}>Escalate</Button></div>
      <ErrorNote msg={error} />
    </div> : <Muted>Your role does not hold the risk.review permission, so you can read but not decide.</Muted>}
  </>;
}
