import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Area, AreaChart, Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";
import type { ColumnDef } from "@tanstack/react-table";
import { Bot, Check, CircleDashed, Clock, Cpu, Download, ExternalLink, Loader2, MinusCircle, Search, ShieldX, User, XCircle } from "lucide-react";
import { useGet } from "../lib/api";
import { cn, usd } from "../lib/utils";
import { Badge, Button, Card, DataTable, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Table } from "../components/ui";
import { Section } from "../components/Shell";
import { Loading } from "./flows";
import { railName } from "./payments";
import { useChartColors } from "./ops";
import { KpiCard, Skeleton, StatusDot, halfDelta } from "../components/kit";
import { Sparkline } from "../components/charts";
import { TraceTimeline } from "../components/TraceTimeline";
import { RouteGraph } from "../components/RouteGraph";

type Step = { key: string; label: string; status: "done" | "failed" | "blocked" | "running" | "waiting" | "skipped" | "not_reached"; actor: { kind: "agent" | "person" | "system"; name: string } | null; at: string | null; durationMs: number | null; reason: string | null; details: any };
type Flow = { intent: any; steps: Step[]; decision: { deterministic: { rail: string | null; reason: string; options: any[] } | null; explanation: string | null; explainedBy: string | null; decidedBy: "router" } };

const STATUS_TEXT: Record<Step["status"], string> = { done: "Done", failed: "Failed", blocked: "Blocked", running: "In progress", waiting: "Waiting", skipped: "Not needed", not_reached: "Not reached" };
const STATUS_STYLE: Record<Step["status"], string> = {
  done: "border-ok bg-ok/10 text-ok", failed: "border-bad bg-bad/10 text-bad", blocked: "border-bad bg-bad/10 text-bad",
  running: "border-warn bg-warn/10 text-warn", waiting: "border-warn bg-warn/10 text-warn", skipped: "border-border bg-subtle text-muted", not_reached: "border-dashed border-border bg-surface text-muted",
};
const STATUS_ICON = { done: Check, failed: XCircle, blocked: ShieldX, running: Loader2, waiting: Clock, skipped: MinusCircle, not_reached: CircleDashed } as const;
const ACTOR_ICON = { agent: Bot, person: User, system: Cpu } as const;
const ACTOR_TEXT = { agent: "Agent", person: "Person", system: "System" } as const;

export const dur = (ms: number | null) => ms === null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const usePrefix = () => (location.pathname.startsWith("/operator") ? "/operator" : "/app");

/** Horizontal step diagram. Nodes that change status after an SSE refresh flash once. */
export function FlowDiagram({ flow, selected, onSelect }: { flow: Flow; selected: string | null; onSelect: (k: string) => void }) {
  const prev = useRef<Record<string, string>>({}); const [changed, setChanged] = useState<Set<string>>(new Set());
  useEffect(() => {
    const c = new Set(flow.steps.filter((s) => prev.current[s.key] && prev.current[s.key] !== s.status).map((s) => s.key));
    prev.current = Object.fromEntries(flow.steps.map((s) => [s.key, s.status]));
    if (c.size) { setChanged(c); const t = setTimeout(() => setChanged(new Set()), 1500); return () => clearTimeout(t); }
  }, [flow]);
  const move = (e: React.KeyboardEvent, n: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
    e.preventDefault(); const k = flow.steps[Math.min(flow.steps.length - 1, Math.max(0, n + d))].key; onSelect(k);
    (document.getElementById(`step-${k}`) as HTMLButtonElement | null)?.focus();
  };
  return <ol className="flex gap-0 overflow-x-auto pb-2" aria-label={`Flow for payment ${flow.intent.id}`}>
    {flow.steps.map((s, n) => {
      const Icon = STATUS_ICON[s.status]; const A = s.actor ? ACTOR_ICON[s.actor.kind] : null;
      return <li key={s.key} className="flex shrink-0 items-start">
        <button id={`step-${s.key}`} type="button" onClick={() => onSelect(s.key)} onKeyDown={(e) => move(e, n)} aria-pressed={selected === s.key}
          aria-label={`${s.label}: ${STATUS_TEXT[s.status]}${s.actor ? `, by ${s.actor.name}` : ""}${s.reason ? `. ${s.reason}` : ""}`}
          className={cn("flex w-[132px] flex-col gap-1 rounded-lg border-2 p-2 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", STATUS_STYLE[s.status], selected === s.key && "ring-2 ring-primary ring-offset-1 ring-offset-surface", changed.has(s.key) && "motion-safe:animate-pulse")}>
          <span className="flex items-center gap-1 text-[12px] font-semibold text-fg"><Icon size={14} aria-hidden className={cn(s.status === "running" && "motion-safe:animate-spin")} />{s.label}</span>
          <span className="text-[11px] font-medium">{STATUS_TEXT[s.status]}</span>
          {s.actor && A && <span className="flex items-center gap-1 truncate text-[11px] text-muted" title={`${ACTOR_TEXT[s.actor.kind]}: ${s.actor.name}`}><A size={12} aria-hidden /><span className="truncate">{s.actor.name}</span></span>}
          {(s.at || s.durationMs !== null) && <span className="text-[11px] tabular-nums text-muted">{time(s.at)}{s.durationMs !== null && ` · ${dur(s.durationMs)}`}</span>}
          {s.reason && (s.status === "failed" || s.status === "blocked") && <span className="line-clamp-2 text-[11px] text-bad" title={s.reason}>{s.reason}</span>}
        </button>
        {n < flow.steps.length - 1 && <span aria-hidden className={cn("mt-6 h-0.5 w-4 shrink-0", s.status === "done" || s.status === "skipped" ? "bg-ok" : "bg-border")} />}
      </li>;
    })}
  </ol>;
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="inline-flex items-center gap-1 text-primary hover:underline" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={12} aria-hidden /><span className="sr-only">(opens in a new tab)</span></a>;
}
function ProviderLinks({ d }: { d: any }) {
  return <div className="flex flex-wrap gap-3 text-[13px]">
    {d.providerRef && <span>Provider ref <Mono>{d.providerRef}</Mono></span>}
    {d.dashboardUrl && <Ext href={d.dashboardUrl}>Open in Stripe dashboard</Ext>}
    {d.explorerUrl && <Ext href={d.explorerUrl}>Open on Basescan</Ext>}
  </div>;
}

/** Details for the selected node, from the same stored records. */
function StepDetails({ s }: { s: Step }) {
  const d = s.details ?? {};
  return <div className="flex flex-col gap-3" aria-live="polite">
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{s.label}</h3><Badge v={STATUS_TEXT[s.status]} tone={s.status === "done" ? "ok" : s.status === "failed" || s.status === "blocked" ? "bad" : s.status === "running" || s.status === "waiting" ? "warn" : "neutral"} />
      {s.actor && <Muted>{ACTOR_TEXT[s.actor.kind]}: {s.actor.name}</Muted>}{s.at && <Muted>at {new Date(s.at).toLocaleString()}</Muted>}{s.durationMs !== null && <Muted>took {dur(s.durationMs)}</Muted>}</div>
    {s.reason && <div className={cn("rounded-md border px-3 py-2 text-xs", s.status === "failed" || s.status === "blocked" ? "border-bad/30 bg-bad/10 text-bad" : "border-border bg-subtle text-muted")}>{s.reason}</div>}
    {s.key === "policy" && d.checks && <Table head={["Check", "Result", "Detail"]}>{d.checks.map((c: any, n: number) => <tr key={n}><td>{c.rule}</td><td><Badge v={c.pass ? "Pass" : "Fail"} tone={c.pass ? "ok" : "bad"} /></td><td className="text-muted">{c.detail}</td></tr>)}</Table>}
    {s.key === "approval" && d.levels?.length > 0 && <Table head={["Level", "Needs", "Approved by"]}>{d.levels.map((l: any, n: number) => <tr key={n}><td>{l.role}</td><td>{l.count}</td><td>{l.approvals.map((a: any) => `${a.userId}${a.comment ? `: ${a.comment}` : ""}`).join(", ") || <Muted>No one yet</Muted>}</td></tr>)}</Table>}
    {s.key === "match" && d.match && <Table head={["Item", "Value"]}><tr><td>Invoice</td><td>{d.invoice} for {usd(d.amount)}</td></tr><tr><td>Result</td><td><Badge v={d.match.status} /></td></tr><tr><td>Read by</td><td>{d.extractedBy}</td></tr></Table>}
    {s.key === "route" && d.options && <Table head={["Rail", "Eligible", "Score", "Fee", "Settles in", "Why"]}>{[...d.options].sort((a: any, b: any) => b.score - a.score).map((o: any) => <tr key={o.rail} className={o.rail === d.rail ? "font-medium" : ""}><td>{railName(o.rail)}{o.rail === d.rail && <Badge className="ml-1" v="Chosen" tone="primary" />}</td><td>{o.eligible ? "Yes" : "No"}</td><td className="tabular-nums">{o.score}</td><td className="tabular-nums">{usd(o.feeUsd)}</td><td>{o.settleMinutes} min</td><td className="text-muted">{o.why?.join(", ")}</td></tr>)}</Table>}
    {s.key === "compliance" && d.checks && <Table head={["Check", "Result", "Detail", "Reference"]}>{d.checks.map((c: any, n: number) => <tr key={n}><td>{c.kind}</td><td><Badge v={c.result} tone={c.result === "pass" ? "ok" : c.result === "fail" ? "bad" : "neutral"} /></td><td className="text-muted">{c.detail}</td><td><Mono>{c.providerRef}</Mono></td></tr>)}</Table>}
    {s.key === "custody" && d.signers && <Muted>Signed by {d.signers.join(", ")}. Quorum {d.quorum}.</Muted>}
    {(s.key === "submitted" || s.key === "settled") && <ProviderLinks d={d} />}
    {s.key === "settled" && d.txHash && <Muted>Transaction hash <Mono>{d.txHash}</Mono></Muted>}
    {s.key === "ledger" && d.journals && <Table head={["Journal", "Memo", "Lines"]}>{d.journals.map((j: any) => <tr key={j.id}><td><Mono>{j.id}</Mono></td><td>{j.memo}</td><td>{j.entries.map((e: any) => `${e.account} ${e.debit ? `Dr ${usd(e.debit)}` : `Cr ${usd(e.credit)}`}`).join(", ")}</td></tr>)}</Table>}
    {["need", "po", "erp"].includes(s.key) && Object.keys(d).length > 0 && <details><summary className="cursor-pointer text-xs text-muted">Show record</summary><pre>{JSON.stringify(d, null, 2)}</pre></details>}
    {s.status === "not_reached" && <Muted>The payment has not reached this step.</Muted>}
  </div>;
}

/** The model explains. The router decides. This card shows both side by side. */
export function DecisionCard({ d }: { d: Flow["decision"] }) {
  if (!d.deterministic) return <Card title="Agent decision"><EmptyState title="No routing decision yet" body="The router has not run for this payment. It runs after the invoice matches." /></Card>;
  const fromModel = d.explainedBy === "llm";
  return <Card title="Agent decision" action={<Badge v="The router decides" tone="primary" />}>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-lg border-2 border-primary/40 p-3"><div className="mb-1 flex items-center gap-1 text-xs font-semibold"><Cpu size={14} aria-hidden />Decision by rules</div>
        <div className="text-[13px]">{d.deterministic.rail ? <>Pay on <strong>{railName(d.deterministic.rail)}</strong>. </> : <><strong>No rail chosen.</strong> </>}{d.deterministic.reason}</div>
        <Muted>This is the decision the platform acts on.</Muted></div>
      <div className="rounded-lg border border-border p-3"><div className="mb-1 flex items-center gap-1 text-xs font-semibold"><Bot size={14} aria-hidden />{fromModel ? "Explanation by Claude" : "Explanation from template"}</div>
        <div className="text-[13px]">{d.explanation ?? <Muted>No explanation stored.</Muted>}</div>
        <Muted>{fromModel ? "Claude explains the decision. It cannot change it." : "Claude was not called, so a template wrote this text."}</Muted></div>
    </div>
  </Card>;
}

/** Full page flow for one payment. Live because SSE refreshes the query. */
export function FlowPage() {
  const { id } = useParams(); const { data, error } = useGet<Flow>(`/flows/${id}`, !!id); const prefix = usePrefix();
  const [sel, setSel] = useState<string | null>(null);
  const firstStop = data?.steps.find((s) => s.status === "failed" || s.status === "blocked" || s.status === "running" || s.status === "waiting")?.key;
  const cur = data?.steps.find((s) => s.key === (sel ?? firstStop ?? "erp"));
  return <Section>
    <PageHeader title={`Payment ${id}`} sub={data ? `${usd(data.intent.amount)} to ${data.intent.supplier ?? "supplier"}${data.intent.rail ? ` on ${railName(data.intent.rail)}` : ""}` : undefined} actions={<Button asChild variant="outline"><Link to={`${prefix}/payments`}>Back to transactions</Link></Button>} />
    {!data ? <Loading error={error as Error} /> : <>
      <Card title="Transaction flow" action={<Badge v={data.intent.status} />}>
        <FlowDiagram flow={data} selected={cur?.key ?? null} onSelect={setSel} />
        <Muted>Select a step to see its details. Use the arrow keys to move between steps.</Muted>
      </Card>
      {cur && <Card title="Step details"><StepDetails s={cur} /></Card>}
      <TraceTimeline id={data.intent.id} />
      <DecisionCard d={data.decision} />
      <RouteGraph options={data.decision.deterministic?.options} chosen={data.decision.deterministic?.rail ?? null} amount={data.intent.amount} supplier={data.intent.supplier} />
    </>}
  </Section>;
}

const STATUSES = ["created", "routed", "submitted", "pending", "settled", "blocked", "denied", "failed"];
const RAILS = ["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"];

/** Transactions page with a Live feed and a History table. */
export function TransactionsPage({ operator }: { operator: boolean }) {
  const [tab, setTab] = useState<"live" | "history">("live");
  const tabs = [["live", "Live"], ["history", "History"]] as const;
  return <Section>
    <PageHeader title="Transactions" sub="Watch payments move in real time, or search past payments" />
    <div role="tablist" aria-label="Transactions view" className="flex gap-1 border-b border-border">
      {tabs.map(([k, l], n) => <button key={k} id={`tab-${k}`} role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`} tabIndex={tab === k ? 0 : -1}
        onClick={() => setTab(k)} onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const nk = tabs[(n + 1) % 2][0]; setTab(nk); document.getElementById(`tab-${nk}`)?.focus(); } }}
        className={cn("-mb-px border-b-2 px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-primary", tab === k ? "border-primary text-fg" : "border-transparent text-muted hover:text-fg")}>{l}</button>)}
    </div>
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>{tab === "live" ? <LiveFeed /> : <History operator={operator} />}</div>
  </Section>;
}

function LiveFeed() {
  const { data, error } = useGet<any[]>("/transactions/feed?limit=60"); const nav = useNavigate(); const prefix = usePrefix();
  const seen = useRef<number | null>(null); const [fresh, setFresh] = useState<number>(0);
  useEffect(() => { if (!data?.length) return; const top = data[0].seq; if (seen.current !== null && top > seen.current) { setFresh(seen.current); const t = setTimeout(() => setFresh(top), 2000); seen.current = top; return () => clearTimeout(t); } seen.current = top; setFresh(top); }, [data]);
  if (error) return <ErrorNote msg={(error as Error).message} />;
  return <Card title="Live events" pad={false} action={<span className="flex items-center gap-1 text-xs text-muted"><span aria-hidden className="h-2 w-2 rounded-full bg-ok motion-safe:animate-pulse" />Updates as they happen</span>}>
    {!data ? <Loading /> : !data.length ? <EmptyState title="No payment events yet" body="Events show here the moment a payment is created, routed, screened or settled. Run a scenario to see one." /> :
      <ul className="divide-y divide-border" aria-live="polite" aria-relevant="additions">{data.map((e) => <li key={e.seq}>
        <button type="button" onClick={() => nav(`${prefix}/payments/${e.intentId}`)} className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-subtle focus-visible:outline-2 focus-visible:outline-primary", e.seq > fresh && "bg-primary/5")} aria-label={`${e.event.replaceAll(".", " ")} for payment ${e.intentId}, ${usd(e.amount)}. Open flow`}>
          <Muted className="w-20 tabular-nums">{time(e.at)}</Muted><span className="min-w-40 text-[13px] font-medium">{e.event.replaceAll(".", " ").replaceAll("_", " ")}</span>
          <Mono>{e.intentId}</Mono><span className="tabular-nums">{usd(e.amount)}</span>{e.rail && <Muted>{railName(e.rail)}</Muted>}<Badge className="ml-auto" v={e.status} tone={e.status === "pending" || e.status === "submitted" ? "warn" : undefined} />
        </button></li>)}</ul>}
  </Card>;
}

function History({ operator }: { operator: boolean }) {
  const [f, setF] = useState({ status: "", rail: "", tenant: "", from: "", to: "", min: "", max: "", q: "" });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data, error } = useGet<{ total: number; rows: any[] }>(`/transactions${qs ? `?${qs}` : ""}`);
  const { data: tenants } = useGet<any[]>("/tenants", operator);
  const nav = useNavigate(); const prefix = usePrefix();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const cols = useMemo<ColumnDef<any>[]>(() => [
    { header: "Date", accessorKey: "createdAt", cell: (c) => <Muted className="tabular-nums">{String(c.getValue<any>()).replace("T", " ").slice(0, 16)}</Muted> },
    { header: "Payment", accessorKey: "id", cell: (c) => <Mono>{c.getValue<any>()}</Mono> },
    ...(operator ? [{ header: "Tenant", accessorKey: "tenant" } as ColumnDef<any>] : []),
    { header: "Supplier", accessorKey: "supplier" },
    { header: "Amount", accessorKey: "amount", cell: (c) => <span className="tabular-nums">{usd(c.getValue<any>())}</span> },
    { header: "Status", accessorKey: "status", cell: (c) => <Badge v={c.getValue<any>()} tone={["pending", "submitted"].includes(c.getValue<any>()) ? "warn" : undefined} /> },
    { header: "Rail", accessorKey: "rail", cell: (c) => railName(c.getValue<any>()) },
    { header: "Reason", accessorKey: "reason", enableSorting: false, cell: (c) => <Muted className="block max-w-[220px] truncate" >{c.getValue<any>()}</Muted> },
  ], [operator]);
  return <Card pad={false} title={data ? `${data.total} payments` : "Payments"} action={<Button asChild size="sm"><a href={`/api/transactions/export.csv${qs ? `?${qs}` : ""}`} download><Download size={13} aria-hidden />Export CSV</a></Button>}>
    <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
      <div className="flex flex-col gap-1 sm:col-span-2"><Label>Search</Label><div className="relative"><Search size={13} aria-hidden className="absolute left-2 top-2.5 text-muted" /><Input className="pl-7" aria-label="Search by payment, supplier, invoice or provider ref" placeholder="Payment, supplier, invoice, ref" value={f.q} onChange={set("q")} /></div></div>
      <div className="flex flex-col gap-1"><Label>Status</Label><Select aria-label="Status" value={f.status} onChange={set("status")}><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></div>
      <div className="flex flex-col gap-1"><Label>Rail</Label><Select aria-label="Rail" value={f.rail} onChange={set("rail")}><option value="">Any rail</option>{RAILS.map((r) => <option key={r} value={r}>{railName(r)}</option>)}</Select></div>
      {operator && <div className="flex flex-col gap-1"><Label>Tenant</Label><Select aria-label="Tenant" value={f.tenant} onChange={set("tenant")}><option value="">Any tenant</option>{(tenants ?? []).filter((t) => t.kind === "client").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></div>}
      <div className="flex flex-col gap-1"><Label>From</Label><Input type="date" aria-label="From date" value={f.from} onChange={set("from")} /></div>
      <div className="flex flex-col gap-1"><Label>To</Label><Input type="date" aria-label="To date" value={f.to} onChange={set("to")} /></div>
      <div className="flex flex-col gap-1"><Label>Amount</Label><div className="flex gap-1"><Input type="number" min={0} aria-label="Minimum amount" placeholder="Min" value={f.min} onChange={set("min")} /><Input type="number" min={0} aria-label="Maximum amount" placeholder="Max" value={f.max} onChange={set("max")} /></div></div>
    </div>
    {error ? <ErrorNote msg={(error as Error).message} /> : !data ? <Loading /> :
      <DataTable data={data.rows} columns={cols} onRow={(r: any) => nav(`${prefix}/payments/${r.id}`)} empty={<EmptyState title={qs ? "No payments match these filters" : "No payments yet"} body={qs ? "Clear a filter or widen the date range." : "Payments show here once an invoice is paid."} action={qs ? <Button size="sm" onClick={() => setF({ status: "", rail: "", tenant: "", from: "", to: "", min: "", max: "", q: "" })}>Clear filters</Button> : undefined} />} />}
  </Card>;
}

const RANGES = [[1, "Last 24 hours"], [7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"]] as const;
/** Settled volume from tenants through rails to suppliers, and blocked volume to Blocked. */
export function MoneyFlowMap() {
  const [days, setDays] = useState(30); const { data, error } = useGet<any>(`/ops/sankey?days=${days}`); const col = useChartColors();
  const fill = (kind: string) => kind === "blocked" ? "var(--bad)" : kind === "rail" ? col.accent : kind === "supplier" ? "var(--ok)" : col.primary;
  const NodeShape = (p: any) => {
    const { x, y, width, height, payload } = p; const right = payload.kind === "supplier" || payload.kind === "blocked";
    return <Layer><Rectangle x={x} y={y} width={width} height={height} fill={fill(payload.kind)} fillOpacity={0.9} />
      <text x={right ? x - 6 : x + width + 6} y={y + height / 2} textAnchor={right ? "end" : "start"} dominantBaseline="middle" fontSize={11} fill={col.muted}>{payload.kind === "rail" ? railName(payload.name) : payload.name}</text></Layer>;
  };
  const summary = data ? `${usd(data.settledVolume)} settled and ${usd(data.blockedVolume)} blocked in the ${RANGES.find((r) => r[0] === days)?.[1].toLowerCase()}` : "";
  return <Card title="Money flow" action={<Select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))}>{RANGES.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</Select>}>
    {error ? <ErrorNote msg={(error as Error).message} /> : !data ? <Loading /> : !data.links.length ? <EmptyState title="No money moved in this range" body="Settled and blocked payments show here. Pick a longer range or run a scenario." /> : <>
      <p className="mb-2 text-xs text-muted">{summary}. Tenants on the left, rails in the middle, suppliers on the right. Blocked payments flow to Blocked.</p>
      <div className="h-80" role="img" aria-label={`Money flow chart. ${summary}.`}>
        <ResponsiveContainer><Sankey data={{ nodes: data.nodes, links: data.links }} nodePadding={24} nodeWidth={10} margin={{ left: 8, right: 8, top: 8, bottom: 8 }} node={<NodeShape />} link={{ stroke: col.muted, strokeOpacity: 0.25 }}>
          <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(v: any) => usd(Number(v))} />
        </Sankey></ResponsiveContainer>
      </div>
      <details className="mt-2"><summary className="cursor-pointer text-xs text-muted">Show as table</summary>
        <Table head={["From", "To", "Amount"]}>{data.links.map((l: any, n: number) => <tr key={n}><td>{railName(data.nodes[l.source].name) || data.nodes[l.source].name}</td><td>{railName(data.nodes[l.target].name) || data.nodes[l.target].name}</td><td className="tabular-nums">{usd(l.value)}</td></tr>)}</Table></details>
    </>}
  </Card>;
}

function Spark({ label, value, data, k, color }: { label: string; value: string; data: any[]; k: string; color: string }) {
  return <div className="rounded-xl border border-border bg-surface p-3">
    <div className="text-xs font-medium text-muted">{label}</div><div className="text-lg font-semibold tabular-nums">{value}</div>
    <div className="h-10" role="img" aria-label={`${label} trend over ${data.length} days: ${data.map((d) => d[k]).join(", ")}`}>
      <ResponsiveContainer><AreaChart data={data} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}><Area type="monotone" dataKey={k} stroke={color} fill={color} fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} /></AreaChart></ResponsiveContainer>
    </div>
  </div>;
}

/** Sparklines and rail health for either home. Scoped to the signed in tenant by the BFF. */
export function HomeStrip() {
  const { data, error } = useGet<any>("/insights/home?days=14"); const col = useChartColors();
  if (error) return <ErrorNote msg={(error as Error).message} />;
  if (!data) return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((n) => <Skeleton key={n} className="h-28 rounded-xl" />)}</div>;
  const s = data.series as any[]; const sum = (k: string) => s.reduce((a, x) => a + x[k], 0);
  return <>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard label="Settled, 14 days" value={usd(sum("settledVolume"))} delta={halfDelta(s.map((x) => x.settledVolume))} trend={<Sparkline data={s} k="settledVolume" color="ok" label="Settled" />} />
      <KpiCard label="Payments, 14 days" value={String(sum("payments"))} delta={halfDelta(s.map((x) => x.payments))} trend={<Sparkline data={s} k="payments" label="Payments" />} />
      <KpiCard label="Blocked, 14 days" value={String(sum("blocked"))} goodWhen="down" delta={halfDelta(s.map((x) => x.blocked))} trend={<Sparkline data={s} k="blocked" color="bad" label="Blocked" />} />
      <KpiCard label="Failed, 14 days" value={String(sum("failed"))} goodWhen="down" delta={halfDelta(s.map((x) => x.failed))} trend={<Sparkline data={s} k="failed" color="warn" label="Failed" />} />
    </div>
    <Card title="Rail health" pad={false}>
      <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">{data.rails.map((r: any) => <li key={r.rail} className="flex flex-col gap-1 p-3">
        <div className="flex items-center gap-2"><StatusDot tone={!r.configured ? "bad" : r.errorRate ? "warn" : "ok"} label={<span className="text-[13px] font-medium text-fg">{railName(r.rail)}</span>} />
          <Badge className="ml-auto" v={r.env === "live" ? "Live" : "Sandbox"} tone={r.env === "live" ? "bad" : "neutral"} /></div>
        <div className="text-xs">{r.configured ? <span className="text-ok">Configured</span> : <span className="text-bad" title={r.notConfiguredReason ?? undefined}>Not configured</span>}</div>
        <Muted>Last success {r.lastSuccess ? new Date(r.lastSuccess).toLocaleString() : "none in 14 days"}</Muted>
        <Muted>Error rate {r.errorRate === null ? "no attempts yet" : `${r.errorRate} percent of ${r.attempts}`}</Muted>
      </li>)}</ul>
    </Card>
  </>;
}
