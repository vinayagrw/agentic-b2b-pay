import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Bot, Check, ChevronRight, Copy, CreditCard, FileSignature, Gauge, Inbox, ShieldAlert, Wallet, type LucideIcon } from "lucide-react";
import { useGet } from "../lib/api";
import { useSSE } from "../lib/stream";
import { arcPath, mergeActivity, preview, railMix, slices, spendByStatus, STATUS_GROUPS, type ActivityItem, type StatusGroup } from "../lib/live";
import { cn, usd } from "../lib/utils";
import { RAIL_LABEL, type Rail } from "@b2b/shared";
import { Card, EmptyState, Mono, Muted } from "./ui";
import { Skeleton, StatusDot, type Tone } from "./kit";

const railName = (r: string) => (r === "none" ? "Not routed" : RAIL_LABEL[r as Rail] ?? r);
const PALETTE = ["var(--brand-primary)", "var(--brand-accent)", "var(--ok)", "var(--warn)", "var(--muted)", "var(--bad)"];
const GROUP: Record<StatusGroup, { label: string; color: string }> = { settled: { label: "Settled", color: "var(--ok)" }, in_flight: { label: "In flight", color: "var(--brand-primary)" }, blocked: { label: "Blocked", color: "var(--warn)" }, failed: { label: "Failed", color: "var(--bad)" } };

/** Donut of payment amount by rail, drawn as plain SVG to keep the charts chunk small. */
export function RailDonut({ intents }: { intents: any[] }) {
  const mix = railMix(intents); const total = mix.reduce((a, m) => a + m.amount, 0); const parts = slices(mix.map((m) => m.amount));
  return <Card title="Payment mix by rail">{!mix.length ? <EmptyState title="No payments yet" /> :
    <div className="grid items-center gap-4 xl:grid-cols-[9rem_minmax(0,1fr)]">
      <svg viewBox="0 0 120 120" className="mx-auto h-36 w-36" role="img" aria-label={`Payment mix by rail: ${mix.map((m, n) => `${railName(m.rail)} ${Math.round(parts[n].share * 100)} percent`).join(", ")}`}>
        {mix.map((m, n) => <path key={m.rail} d={arcPath(parts[n].from, parts[n].to, 58, 38, 60)} style={{ fill: PALETTE[n % PALETTE.length] }} stroke="var(--surface)" strokeWidth={1.5}><title>{`${railName(m.rail)}: ${usd(m.amount)}`}</title></path>)}
        <text x="60" y="57" textAnchor="middle" className="fill-muted text-[9px]">Total</text>
        <text x="60" y="71" textAnchor="middle" className="fill-fg text-[11px] font-semibold">{usd(total).replace(/\.\d+$/, "")}</text>
      </svg>
      <ul className="min-w-0 space-y-1 text-xs xl:min-w-56">{mix.map((m, n) => <li key={m.rail} className="flex items-center gap-2">
        <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[n % PALETTE.length] }} />
        <span className="min-w-0 flex-1 truncate">{railName(m.rail)}</span><span className="tabular-nums text-muted">{m.count}</span><span className="text-right tabular-nums">{usd(m.amount)}</span><span className="w-9 text-right tabular-nums text-muted">{Math.round(parts[n].share * 100)}%</span>
      </li>)}</ul>
    </div>}</Card>;
}

/** Horizontal stacked bars of spend per supplier split by status. */
export function SupplierStatusBars({ intents, invoices, suppliers }: { intents: any[]; invoices: any[]; suppliers: any[] }) {
  const rows = spendByStatus(intents, invoices, suppliers); const max = Math.max(1, ...rows.map((r) => r.total));
  return <Card title="Spend by status per supplier" action={<span className="flex flex-wrap gap-3">{STATUS_GROUPS.map((g) => <span key={g} className="inline-flex items-center gap-1 text-[11px] text-muted"><span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: GROUP[g].color }} />{GROUP[g].label}</span>)}</span>}>
    {!rows.length ? <EmptyState title="No supplier spend yet" /> : <ul className="space-y-2.5">{rows.map((r) => <li key={r.supplier}>
      <div className="flex justify-between gap-2 text-xs"><span className="truncate font-medium">{r.supplier}</span><span className="tabular-nums text-muted">{usd(r.total)}</span></div>
      <div className="mt-1 flex h-3 overflow-hidden rounded-sm bg-subtle" style={{ width: `${Math.max(4, (r.total / max) * 100)}%` }} role="img" aria-label={`${r.supplier}: ${STATUS_GROUPS.filter((g) => r[g]).map((g) => `${GROUP[g].label} ${usd(r[g])}`).join(", ")}`}>
        {STATUS_GROUPS.map((g) => r[g] > 0 && <div key={g} title={`${GROUP[g].label} ${usd(r[g])}`} style={{ width: `${(r[g] / r.total) * 100}%`, background: GROUP[g].color }} />)}
      </div>
    </li>)}</ul>}
  </Card>;
}

/** Both home charts from the app state. */
export function HomeMixCharts({ st }: { st: any }) {
  return <div className="grid gap-4 lg:grid-cols-2"><RailDonut intents={st.intents ?? []} /><SupplierStatusBars intents={st.intents ?? []} invoices={st.invoices ?? []} suppliers={st.suppliers ?? []} /></div>;
}

type Pulse = { at: string; tenantId: string; rails: { rail: string; label: string; state: "ok" | "degraded" | "down" | "off"; attempts: number; failed: number }[]; queue: { approvals: number; risk: number }; failures: { failed: number; attempts: number; ratePct: number }; float: { total: number; rails: number; errors: number } };
const RAIL_TONE: Record<Pulse["rails"][number]["state"], Tone> = { ok: "ok", degraded: "warn", down: "bad", off: "neutral" };
const RAIL_WORD = { ok: "Healthy", degraded: "Degraded", down: "Down", off: "Not configured" };

function PulseCell({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
  return <div className="min-w-0 px-4 py-2.5"><div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted"><Icon size={12} aria-hidden />{label}</div><div className="mt-0.5">{children}</div></div>;
}

/** Live strip for the operator home: rail health, queue depth, failure rate over 24 hours and float. Pushed over SSE. */
export function LivePulse() {
  const { data: first, error } = useGet<Pulse>("/live/pulse"); const [live, setLive] = useState<Pulse | null>(null);
  const status = useSSE<Pulse>("/api/live/stream", ["pulse"], (m) => { if (m.event === "pulse" && m.data && typeof m.data === "object") setLive(m.data); });
  const p = live ?? first;
  if (error && !p) return null;
  return <section aria-label="Live pulse" className="rounded-lg border border-border bg-surface">
    {!p ? <div className="p-3"><Skeleton lines={2} /></div> : <div className="grid divide-border sm:grid-cols-2 sm:divide-x lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
      <PulseCell icon={Activity} label="Rail health">
        <ul className="flex flex-wrap gap-x-3 gap-y-1">{p.rails.map((r) => <li key={r.rail} title={`${RAIL_WORD[r.state]}, ${r.failed} of ${r.attempts} failed in 24 hours`}><StatusDot tone={RAIL_TONE[r.state]} label={<span className="text-xs">{r.label}<span className="sr-only"> {RAIL_WORD[r.state]}</span></span>} /></li>)}</ul>
      </PulseCell>
      <PulseCell icon={Inbox} label="Queue"><span className="text-lg font-semibold tabular-nums">{p.queue.approvals}</span> <Muted>approvals</Muted> <span className="ml-1 text-lg font-semibold tabular-nums">{p.queue.risk}</span> <Muted>risk</Muted></PulseCell>
      <PulseCell icon={ShieldAlert} label="Failures 24h"><span className={cn("text-lg font-semibold tabular-nums", p.failures.ratePct > 5 ? "text-bad" : "")}>{p.failures.ratePct}%</span> <Muted>{p.failures.failed} of {p.failures.attempts}</Muted></PulseCell>
      <PulseCell icon={Wallet} label="Float"><span className="text-lg font-semibold tabular-nums">{usd(p.float.total)}</span> <Muted>{p.float.rails} rails{p.float.errors ? `, ${p.float.errors} unread` : ""}</Muted></PulseCell>
    </div>}
    <div className="flex items-center justify-between border-t border-border px-4 py-1 text-[11px] text-muted"><StatusDot tone={status === "open" ? "ok" : "neutral"} pulse={status === "open"} label={status === "open" ? "Live" : "Reconnecting"} />{p && <span>Updated {new Date(p.at).toLocaleTimeString()}</span>}</div>
  </section>;
}

const KIND: Record<ActivityItem["kind"], { icon: LucideIcon; label: string; tone: string }> = {
  payment: { icon: CreditCard, label: "Payment", tone: "text-primary" }, approval: { icon: Check, label: "Approval", tone: "text-ok" }, agent: { icon: Bot, label: "Agent", tone: "text-accent" },
  risk: { icon: ShieldAlert, label: "Risk", tone: "text-warn" }, mandate: { icon: FileSignature, label: "Mandate", tone: "text-muted" },
};

/** Live stream of payments, approvals, agent actions, risk and mandate events. */
export function ActivityFeed({ prefix, max = 12 }: { prefix: "/operator" | "/app"; max?: number }) {
  const { data, error } = useGet<ActivityItem[]>("/live/activity?limit=30"); const [items, setItems] = useState<ActivityItem[]>([]); const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => { if (data) setItems((cur) => mergeActivity(cur, data)); }, [data]);
  const status = useSSE<ActivityItem[]>("/api/live/stream", ["activity"], (m) => { if (!Array.isArray(m.data)) return; const xs = m.data; setItems((cur) => mergeActivity(cur, xs)); setFresh(new Set(xs.map((x) => x.id))); });
  const shown = items.slice(0, max);
  return <Card title="Activity" pad={false} action={<StatusDot tone={status === "open" ? "ok" : "neutral"} pulse={status === "open"} label={status === "open" ? "Live" : "Connecting"} />}>
    {!data && !error ? <div className="p-4"><Skeleton lines={4} /></div> : !shown.length ? <EmptyState icon={Gauge} title="No activity yet" body="Payments, approvals, agent actions, risk and mandate events appear here as they happen." /> :
      <ol className="divide-y divide-border" aria-live="polite">{shown.map((a) => { const k = KIND[a.kind]; const Icon = k.icon;
        const body = <><Icon size={14} aria-hidden className={cn("mt-0.5 shrink-0", k.tone)} /><span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{a.title}</span><span className="block text-[11px] text-muted">{k.label} <Mono>{a.subjectId}</Mono></span></span><time dateTime={a.at} className="shrink-0 text-[11px] tabular-nums text-muted">{a.at.slice(11, 19)}</time>{a.paymentId && <ChevronRight size={13} aria-hidden className="mt-0.5 text-muted" />}</>;
        const cls = cn("flex items-start gap-2 px-4 py-2", fresh.has(a.id) && "motion-safe:animate-[pulse_1s_ease-out_1]");
        return <li key={a.id}>{a.paymentId ? <Link to={`${prefix}/payments/${a.paymentId}`} className={cn(cls, "hover:bg-subtle")}>{body}</Link> : <div className={cls}>{body}</div>}</li>; })}</ol>}
  </Card>;
}

/** Collapsible JSON tree. Objects and arrays fold, leaves show typed values. */
export function JsonTree({ value, name, depth = 0, open: start }: { value: unknown; name?: string; depth?: number; open?: boolean }) {
  const branch = value !== null && typeof value === "object"; const [open, setOpen] = useState(start ?? depth < 1);
  const label = name !== undefined && <span className="text-primary">{name}</span>;
  if (!branch) return <div className="pl-4 leading-5">{label}{label && <span className="text-muted">: </span>}<span className={typeof value === "string" ? "text-ok" : typeof value === "number" ? "text-accent" : "text-muted"}>{typeof value === "string" ? JSON.stringify(value) : String(value)}</span></div>;
  const entries = Array.isArray(value) ? value.map((v, n) => [String(n), v] as const) : Object.entries(value as object);
  return <div className="leading-5">
    <button type="button" className="inline-flex items-center gap-0.5 rounded text-left hover:bg-subtle" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronRight size={12} aria-hidden className={cn("transition-transform", open && "rotate-90")} />{label}{label && <span className="text-muted">: </span>}{!open && <span className="text-muted">{preview(value)}</span>}{open && <span className="text-muted">{Array.isArray(value) ? "[" : "{"}</span>}</button>
    {open && <div className="ml-1.5 border-l border-border pl-1">{entries.map(([k, v]) => <JsonTree key={k} name={k} value={v} depth={depth + 1} />)}<span className="pl-3 text-muted">{Array.isArray(value) ? "]" : "}"}</span></div>}
  </div>;
}

/** JSON tree with a title and a copy button. */
export function JsonViewer({ title, value, meta }: { title: string; value: unknown; meta?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } };
  return <details className="group min-w-0 rounded-lg border border-border">
    <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-[13px]"><ChevronRight size={13} aria-hidden className="transition-transform group-open:rotate-90" /><span className="font-medium">{title}</span>{meta && <span className="min-w-0 break-all text-[11px] text-muted">{meta}</span>}
      <button type="button" className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-subtle hover:text-fg" onClick={(e) => { e.preventDefault(); void copy(); }} aria-label={`Copy ${title} JSON`}>{copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}{copied ? "Copied" : "Copy"}</button></summary>
    <div className="overflow-x-auto border-t border-border bg-subtle/50 px-2 py-2 font-mono text-[12px]"><JsonTree value={value} open /></div>
  </details>;
}

type Payloads = { webhooks: { provider: string; eventId: string; type: string; receivedAt: string; record: unknown }[]; records: { id: string; event: string; at: string; payload: unknown }[]; route: unknown };
/** Provider webhook events and stored API payloads for one payment. */
export function PayloadsCard({ id }: { id: string }) {
  const { data, error } = useGet<Payloads>(`/payments/${id}/payloads`, !!id);
  return <Card title="Payloads">{error ? <EmptyState title="Payloads not available" body={(error as Error).message} /> : !data ? <Skeleton lines={3} /> : <div className="space-y-3">
    <section><h3 className="mb-1.5 text-xs font-medium text-muted">Provider webhooks</h3>{data.webhooks.length ? <div className="space-y-1.5">{data.webhooks.map((w) => <JsonViewer key={w.eventId} title={w.type} meta={`${w.provider} ${w.eventId} at ${new Date(w.receivedAt).toLocaleTimeString()}`} value={w} />)}</div> : <Muted>No provider webhooks received for this payment.</Muted>}</section>
    <section><h3 className="mb-1.5 text-xs font-medium text-muted">API and decision payloads</h3><div className="space-y-1.5">
      {data.route ? <JsonViewer title="Route decision" value={data.route} /> : null}
      {data.records.map((r) => <JsonViewer key={r.id} title={r.event} meta={`${r.id} at ${new Date(r.at).toLocaleTimeString()}`} value={r.payload} />)}
    </div></section>
  </div>}</Card>;
}

/** Generic donut for label and value pairs, same SVG arcs as the rail donut. Used by the copilot answers. */
export function DonutChart({ title, data, format = (n: number) => String(n) }: { title: string; data: { label: string; value: number }[]; format?: (n: number) => string }) {
  const parts = slices(data.map((d) => d.value)); const total = data.reduce((a, d) => a + d.value, 0);
  return <div className="flex items-center gap-3">
    <svg viewBox="0 0 120 120" className="h-24 w-24 shrink-0" role="img" aria-label={`${title}: ${data.map((d, n) => `${d.label} ${Math.round(parts[n].share * 100)} percent`).join(", ")}`}>
      {data.map((d, n) => <path key={d.label + n} d={arcPath(parts[n].from, parts[n].to, 58, 38, 60)} style={{ fill: PALETTE[n % PALETTE.length] }} stroke="var(--surface)" strokeWidth={1.5}><title>{`${d.label}: ${format(d.value)}`}</title></path>)}
      <text x="60" y="65" textAnchor="middle" className="fill-fg text-[12px] font-semibold">{format(total)}</text>
    </svg>
    <ul className="min-w-0 flex-1 space-y-0.5 text-[11px]">{data.map((d, n) => <li key={d.label + n} className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 shrink-0 rounded-sm" style={{ background: PALETTE[n % PALETTE.length] }} /><span className="min-w-0 flex-1 truncate">{d.label}</span><span className="tabular-nums text-muted">{format(d.value)}</span></li>)}</ul>
  </div>;
}

/** Generic horizontal bars for label and value pairs. */
export function BarList({ title, data, format = (n: number) => String(n) }: { title: string; data: { label: string; value: number }[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  return <ul className="space-y-1.5" aria-label={title}>{data.map((d, n) => <li key={d.label + n}>
    <div className="flex justify-between gap-2 text-[11px]"><span className="truncate">{d.label}</span><span className="tabular-nums text-muted">{format(d.value)}</span></div>
    <div className="mt-0.5 h-2 rounded-sm" role="img" aria-label={`${d.label} ${format(d.value)}`} style={{ width: `${Math.max(3, (Math.abs(d.value) / max) * 100)}%`, background: d.value < 0 ? "var(--bad)" : PALETTE[0] }} />
  </li>)}</ul>;
}

/** Small scrollable table for answer data. */
export function DataTable({ columns, rows, max = 8 }: { columns: string[]; rows: (string | number)[][]; max?: number }) {
  return <div className="overflow-x-auto"><table className="w-full text-[11px]"><thead><tr>{columns.map((c) => <th key={c} scope="col" className="whitespace-nowrap border-b border-border px-1.5 py-1 text-left font-medium text-muted">{c}</th>)}</tr></thead>
    <tbody>{rows.slice(0, max).map((r, n) => <tr key={n} className="border-b border-border/60">{r.map((v, k) => <td key={k} className={cn("whitespace-nowrap px-1.5 py-1", typeof v === "number" && "text-right tabular-nums")}>{String(v)}</td>)}</tr>)}</tbody></table>
    {rows.length > max && <Muted>{rows.length - max} more rows in the CSV</Muted>}</div>;
}
