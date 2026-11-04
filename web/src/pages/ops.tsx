import { useState } from "react";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, FileWarning, Landmark, RefreshCw, Scale, ShieldAlert } from "lucide-react";
import { api, useAct, useGet, type Tenant } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Mono, Muted, PageHeader, Select, Stat, Table, Textarea } from "../components/ui";
import { Section } from "../components/Shell";
import { Loading, EvidenceLog } from "./flows";
import { railName } from "./payments";

/** Operator pages act on one business client at a time. */
export function useClientPicker() {
  const { data } = useGet<Tenant[]>("/tenants");
  const clients = (data ?? []).filter((t) => t.kind === "client");
  const [id, setId] = useState<string>(() => { try { return localStorage.getItem("ops-tenant") ?? ""; } catch { return ""; } });
  const t = clients.find((c) => c.id === id) ?? clients[0];
  const pick = <Select aria-label="Business client" value={t?.id ?? ""} onChange={(e) => { setId(e.target.value); try { localStorage.setItem("ops-tenant", e.target.value); } catch { /* private mode */ } }}>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>;
  return { tenantId: t?.id, tenant: t, pick };
}
/** Recharts writes colours as SVG attributes, where CSS variables do not resolve. Read the theme values instead. */
export function useChartColors() {
  const { data: me } = useGet<any>("/me");
  const css = (v: string, d: string) => { try { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || d; } catch { return d; } };
  return { primary: me?.theme?.primary ?? css("--brand-primary", "#1d4ed8"), accent: me?.theme?.accent ?? css("--brand-accent", "#f59e0b"), grid: css("--border", "#e2e8f0"), muted: css("--muted", "#64748b") };
}
const axis = { fontSize: 11, fill: "var(--muted)" };
const tip = { contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "var(--fg)" } };
const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));

export function TreasuryPage() {
  const { tenantId, pick } = useClientPicker();
  const { data, error, refetch, isFetching } = useGet<any>(`/ops/treasury?tenantId=${tenantId}`, !!tenantId);
  const col = useChartColors();
  const { run, busy, error: e2 } = useAct(); const [amt, setAmt] = useState<Record<string, string>>({}); const [last, setLast] = useState<any>(null);
  return <Section>
    <PageHeader title="Treasury" sub="Balances come live from each configured rail. The forecast uses open invoices by due date." actions={<>{pick}<Button size="sm" variant="ghost" disabled={isFetching} onClick={() => refetch()}><RefreshCw size={13} />Refresh</Button></>} />
    {!data ? <Loading error={error as Error} /> : <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Landmark} label="Cash across rails" value={usd(data.startingCash)} hint={`${data.configured} of 4 rails configured`} />
        <Stat icon={FileWarning} label="Open invoices" value={usd(data.openAmount)} hint={`${data.openInvoices} invoices`} />
        <Stat label="Projected in 30 days" value={usd(data.forecast[30].balance)} hint={data.forecast[30].balance < 0 ? "Shortfall, fund the rails" : "After all open invoices due"} />
        <Stat label="Due after 30 days" value={usd(data.beyond30)} />
      </div>
      <Card title="Balances by rail" pad={false}><Table head={["Rail", "Environment", "Balance", "Source", "Sweep to fiat"]}>{data.balances.map((b: any) => <tr key={b.rail}>
        <td className="font-medium">{railName(b.rail)}</td><td><Badge v={b.env === "live" ? "LIVE" : "TEST"} tone={b.env === "live" ? "bad" : "neutral"} /></td>
        <td className="tabular-nums">{b.error ? <Badge v={b.error} tone="bad" /> : `${b.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${b.currency}`}</td><td><Muted>{b.detail ?? ""}</Muted></td>
        <td>{!b.rail.endsWith("usdc") ? <Muted>Already fiat</Muted> : <div className="flex flex-col gap-1"><div className="flex gap-1"><Input className="w-24" type="number" min={0} aria-label="Sweep amount" value={amt[b.rail] ?? ""} onChange={(e) => setAmt({ ...amt, [b.rail]: e.target.value })} placeholder="USDC" />
          <Button size="sm" disabled={busy || !Number(amt[b.rail])} onClick={async () => setLast(await run(() => api("/ops/treasury/sweep", { tenantId, rail: b.rail, amount: Number(amt[b.rail]) })))}>Sweep</Button></div>{!b.sweep.supported && <Muted className="max-w-xs">Not supported. {b.sweep.reason}</Muted>}</div>}</td></tr>)}</Table>
        <div className="px-4 pb-3"><ErrorNote msg={e2} />{last && <div className="mt-2 text-xs"><Badge v={last.status} tone={last.status === "unsupported" ? "warn" : undefined} /> {last.detail}</div>}</div></Card>
      <Card title="30 day cash forecast">
        <div className="h-64"><ResponsiveContainer><ComposedChart data={data.forecast} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid stroke={col.grid} vertical={false} /><XAxis dataKey="day" tick={{ ...axis, fill: col.muted }} tickFormatter={(d) => d.slice(5)} interval={4} /><YAxis tick={{ ...axis, fill: col.muted }} tickFormatter={k} width={48} />
          <Tooltip {...tip} formatter={(v: any, n: any) => [usd(Number(v)), n === "balance" ? "Projected balance" : "Invoices due"]} />
          <Area type="stepAfter" dataKey="balance" stroke={col.primary} fill={col.primary} fillOpacity={0.12} strokeWidth={2} />
          <Bar dataKey="outflow" fill={col.accent} barSize={8} />
        </ComposedChart></ResponsiveContainer></div>
        {!data.openInvoices && <Muted>No open invoices, so the line stays flat at today's balance.</Muted>}
      </Card>
      <Card title="Sweeps" pad={false}>{data.sweeps.length ? <Table head={["Sweep", "Rail", "Amount", "Status", "Detail", "By"]}>{data.sweeps.map((s: any) => <tr key={s.id}><td><Mono>{s.id}</Mono></td><td>{railName(s.rail)}</td><td className="tabular-nums">{usd(s.amount)}</td><td><Badge v={s.status} tone={s.status === "unsupported" ? "warn" : undefined} /></td><td><Muted>{s.detail}</Muted></td><td>{s.requestedBy}</td></tr>)}</Table> : <EmptyState title="No sweeps yet" />}</Card>
      <Card title="Ledger positions" pad={false}>{data.ledger.length ? <Table head={["Account", "Debit", "Credit", "Balance"]}>{data.ledger.map((a: any) => <tr key={a.account}><td>{a.account}</td><td className="tabular-nums">{usd(a.debit)}</td><td className="tabular-nums">{usd(a.credit)}</td><td className="tabular-nums">{usd(a.balance)}</td></tr>)}</Table> : <EmptyState title="No journals yet" />}</Card>
    </>}
  </Section>;
}

const KIND: Record<string, string> = { unmatched: "Unmatched", amount_mismatch: "Amount mismatch", late: "Late" };
function ExceptionRow({ x, tenantId }: { x: any; tenantId: string }) {
  const { run, busy, error } = useAct(); const [note, setNote] = useState("");
  const go = (action: string) => run(() => api(`/ops/recon/exceptions/${encodeURIComponent(x.id)}/resolve`, { tenantId, action, note }));
  return <li className="px-4 py-3"><div className="flex flex-wrap items-center gap-2"><Badge v={KIND[x.kind]} tone={x.status === "resolved" ? "neutral" : "bad"} /><span className="flex-1 text-[13px]">{x.title}</span><Badge v={x.status} tone={x.status === "resolved" ? "ok" : "warn"} /></div>
    {x.status === "open" ? <div className="mt-2 flex flex-wrap gap-2"><Input className="max-w-sm" placeholder="Resolution note" value={note} onChange={(e) => setNote(e.target.value)} />
      {x.kind === "late" ? <Button size="sm" disabled={busy} onClick={() => go("recheck")}>Recheck with provider</Button> : x.kind === "amount_mismatch" ? <Button size="sm" disabled={busy} onClick={() => go("post_adjustment")}>Post adjusting journal</Button> : null}
      <Button size="sm" disabled={busy} onClick={() => go("accept")}>Accept with note</Button></div>
      : <Muted className="mt-1 block">{x.resolution.action} by {x.resolution.by} at {x.resolution.at.slice(0, 16).replace("T", " ")}. {x.resolution.note}{x.resolution.journalId ? ` Journal ${x.resolution.journalId}.` : ""}</Muted>}
    <ErrorNote msg={error} /></li>;
}
export function ReconPage() {
  const { tenantId, pick } = useClientPicker();
  const { data, error } = useGet<any>(`/ops/recon?tenantId=${tenantId}`, !!tenantId);
  const { run, busy } = useAct();
  const open = data?.exceptions.filter((x: any) => x.status === "open") ?? [];
  return <Section>
    <PageHeader title="Reconciliation" sub="Each rail event is matched to a ledger journal and each webhook to a payment. Problems land in the exceptions queue." actions={<>{pick}
      <Button size="sm" disabled={busy || !tenantId} onClick={() => run(() => api("/ops/recon/run", { tenantId }))}><Scale size={13} />Run match</Button>
      <Button size="sm" variant="ghost" asChild><a href={`/api/ops/recon/export.csv?tenantId=${tenantId}`}><Download size={13} />CSV</a></Button>
      <Button size="sm" variant="ghost" asChild><a href={`/api/statements/camt053?tenantId=${tenantId}`}><Download size={13} />camt.053</a></Button></>} />
    {!data ? <Loading error={error as Error} /> : <>
      <div className="grid gap-3 sm:grid-cols-3"><Stat label="Settlements matched" value={`${data.matched} of ${data.total}`} /><Stat label="Open exceptions" value={open.length} /><Stat label="Resolved" value={data.exceptions.length - open.length} /></div>
      <Card title="Exceptions queue" pad={false}>{data.exceptions.length ? <ul className="divide-y divide-border">{data.exceptions.map((x: any) => <ExceptionRow key={x.id} x={x} tenantId={tenantId!} />)}</ul> : <EmptyState title="No exceptions" body="Every settlement matches a journal for the right amount, and every payment webhook matches a payment." />}</Card>
      <Card title="Matches" pad={false}>{data.rows.length ? <Table head={["Settlement", "Payment", "Rail", "Provider ref", "Amount", "Journal", "Status"]}>{data.rows.map((r: any) => <tr key={r.settlementId}><td><Mono>{r.settlementId}</Mono></td><td><Mono>{r.intentId}</Mono></td><td>{railName(r.rail)}</td><td><Mono className="block max-w-[180px] truncate">{r.txHash ?? r.providerRef}</Mono></td><td className="tabular-nums">{usd(r.amount)}</td><td><Mono>{r.journalId ?? "none"}</Mono></td><td><Badge v={r.status} /></td></tr>)}</Table> : <EmptyState title="No settlements yet" />}</Card>
    </>}
  </Section>;
}

function CaseCard({ c }: { c: any }) {
  const { run, busy, error } = useAct(); const [text, setText] = useState<string | null>(null); const [res, setRes] = useState("");
  const d = c.detail ?? {};
  return <Card title={<span className="flex items-center gap-2"><ShieldAlert size={14} className="text-bad" />{c.title}</span>} action={<><Badge v={c.kind} tone="neutral" /><Badge v={c.status} tone={c.status === "open" ? "warn" : "neutral"} /></>}>
    <div className="flex flex-col gap-3">
      <Muted>{c.id} opened {c.openedAt.slice(0, 16).replace("T", " ")} for {c.tenantId}{c.intentId ? `, payment ${c.intentId}` : ""}</Muted>
      {c.kind === "sanctions" && <Table head={["List", "Entry", "Program", "Matched on", "Value", "Score"]}>{(d.hits ?? []).map((h: any, n: number) => <tr key={n}><td><Badge v={h.source} tone={h.source === "OFAC SDN" ? "bad" : "warn"} /></td><td>{h.sdnName} <Mono className="text-muted">{h.uid}</Mono></td><td>{h.program}</td><td>{h.matchedOn}{h.asset ? ` ${h.asset}` : ""}</td><td><Mono className="break-all">{h.value}</Mono></td><td className="tabular-nums">{h.score}</td></tr>)}</Table>}
      {c.kind === "dispute" && <Table><tr><td className="text-muted">Dispute</td><td><Mono>{d.id}</Mono> {d.reason}</td></tr><tr><td className="text-muted">Amount</td><td>{usd(d.amount)}</td></tr><tr><td className="text-muted">Charge</td><td><Mono>{d.chargeId}</Mono></td></tr></Table>}
      {d.travelRule && <details><summary className="cursor-pointer text-xs font-medium">Travel Rule record</summary><TravelRule r={d.travelRule} /></details>}
      {c.kind === "sanctions" && <div className="rounded-lg bg-subtle p-3"><div className="flex items-center gap-2 text-xs font-medium">SAR narrative {c.sar ? <><Badge v={c.sar.status} tone={c.sar.status === "draft" ? "warn" : "ok"} /><Muted>drafted by {c.sar.draftedBy}, last edit {c.sar.updatedBy}</Muted></> : <Muted>none yet</Muted>}</div>
        {c.sar && (text !== null ? <Textarea className="mt-2 min-h-48 font-sans text-[13px]" value={text} onChange={(e) => setText(e.target.value)} /> : <p className="mt-2 whitespace-pre-wrap text-[13px]">{c.sar.text}</p>)}
        <div className="mt-2 flex flex-wrap gap-2">
          {(!c.sar || c.sar.status === "draft") && <Button size="sm" disabled={busy} onClick={() => run(() => api(`/ops/cases/${c.id}/sar/draft`, {}))}>{c.sar ? "Redraft with the model" : "Draft SAR with the model"}</Button>}
          {c.sar?.status === "draft" && (text === null ? <Button size="sm" onClick={() => setText(c.sar.text)}>Edit</Button> : <Button size="sm" variant="primary" disabled={busy} onClick={async () => { if (await run(() => api(`/ops/cases/${c.id}/sar`, { text }, { method: "PUT" }))) setText(null); }}>Save edit</Button>)}
          {c.sar?.status === "draft" && text === null && <Button size="sm" variant="primary" disabled={busy} onClick={() => confirm("File this SAR internally? It cannot be edited after.") && run(() => api(`/ops/cases/${c.id}/sar/file`, {}))}>File internally</Button>}
        </div><Muted className="mt-1 block">A person reviews every draft. Filing here records it internally, nothing is sent to a regulator.</Muted></div>}
      {c.kind === "dispute" && <Button size="sm" asChild className="self-start"><a href={`/api/cases/${c.id}/evidence-pack`}><Download size={13} />Evidence pack</a></Button>}
      {c.status === "open" ? <div className="flex gap-2"><Input placeholder="Why close it" value={res} onChange={(e) => setRes(e.target.value)} /><Button size="sm" disabled={busy || !res} onClick={() => run(() => api(`/ops/cases/${c.id}/close`, { resolution: res }))}>Close case</Button></div> : <Muted>Closed by {c.closedBy}: {c.resolution}</Muted>}
      <ErrorNote msg={error} />
    </div>
  </Card>;
}
function TravelRule({ r }: { r: any }) {
  return <Table>
    <tr><td className="text-muted">Standard</td><td>{r.standard}</td></tr><tr><td className="text-muted">Amount</td><td>{usd(r.amount)} {r.asset} on {r.chain}</td></tr>
    <tr><td className="text-muted">Originator</td><td>{r.originator?.legalPerson} ({r.originator?.country}) <Mono>{r.originator?.wallet}</Mono></td></tr>
    <tr><td className="text-muted">Beneficiary</td><td>{r.beneficiary?.legalPerson} ({r.beneficiary?.country}) <Mono>{r.beneficiary?.wallet ?? "none"}</Mono></td></tr>
    <tr><td className="text-muted">VASPs</td><td>{r.originatingVasp} to {r.beneficiaryVasp}</td></tr>
  </Table>;
}
export function CompliancePage() {
  const { data, error } = useGet<any>("/ops/compliance"); const [tab, setTab] = useState<"open" | "closed" | "travel" | "audit">("open");
  if (!data) return <Loading error={error as Error} />;
  const cases = data.cases.filter((c: any) => (tab === "open" ? c.status === "open" : c.status === "closed"));
  return <Section>
    <PageHeader title="Compliance" sub="Names and wallets are screened locally against the OFAC SDN list. Hits open a case for a person to review." />
    <div className="flex flex-wrap items-center gap-2 text-xs">{data.sdn.loaded ? <><Badge v="OFAC SDN loaded" tone="ok" /><Muted>{data.sdn.entries.toLocaleString()} entries and {data.sdn.addresses} digital currency addresses, downloaded {String(data.sdn.fetchedAt ?? "").slice(0, 10)}</Muted></> : <><Badge v="OFAC SDN not downloaded" tone="bad" /><Muted>Run npm run sdn:fetch --workspace bff. Until then only the demo watchlist is screened.</Muted></>}</div>
    <div className="flex gap-1">{([["open", `Open cases (${data.cases.filter((c: any) => c.status === "open").length})`], ["closed", "Closed"], ["travel", `Travel Rule (${data.travelRule.length})`], ["audit", "Audit chain"]] as const).map(([k2, l]) => <Button key={k2} size="sm" variant={tab === k2 ? "primary" : "ghost"} onClick={() => setTab(k2)}>{l}</Button>)}</div>
    {tab === "travel" ? <Card title={`Transfers at or above ${usd(data.travelRuleThresholdUsd)}`} pad={false}>{data.travelRule.length ? <ul className="divide-y divide-border">{data.travelRule.map((t: any) => <li key={t.intentId} className="px-4 py-3"><div className="mb-2 flex items-center gap-2"><Mono>{t.intentId}</Mono><Badge v={t.status} /><span className="tabular-nums">{usd(t.amount)}</span><Muted>{t.tenantId}</Muted></div><TravelRule r={t.record} /></li>)}</ul> : <EmptyState title="No Travel Rule records" body="Stablecoin transfers at or above the threshold get an IVMS101 record." />}</Card>
      : tab === "audit" ? <EvidenceLog />
      : cases.length ? <div className="grid gap-3 xl:grid-cols-2">{cases.map((c: any) => <CaseCard key={c.id} c={c} />)}</div> : <Card><EmptyState icon={ShieldAlert} title={tab === "open" ? "No open cases" : "No closed cases"} body="A sanctions hit on a payment or a supplier, or a card dispute, opens a case here." /></Card>}
  </Section>;
}
