import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, ArrowLeftRight, BadgeDollarSign, Bot, Copy, KeyRound, Scale, ShieldAlert, Webhook } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Stat, Table } from "../components/ui";
import { Section } from "../components/Shell";
import { Loading } from "./flows";
import { PaymentsTable, railName } from "./payments";
import { useChartColors, useClientPicker } from "./ops";
import { HomeStrip, MoneyFlowMap } from "./txflow";

const axis = { fontSize: 11, fill: "var(--muted)" };
const tip = { contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "var(--fg)" } };

export function OperatorHome() {
  const { data: k, error } = useGet<any>("/ops/kpis"); const { run, busy, error: e2 } = useAct(); const col = useChartColors();
  if (!k) return <Loading error={error as Error} />;
  return <Section>
    <PageHeader title="Home" sub={`Volume, risk and revenue across all tenants, last ${k.days} days`} actions={<Button variant={k.killSwitch ? "outline" : "danger"} disabled={busy} onClick={() => run(() => api("/kill-switch", { on: !k.killSwitch }))}>{k.killSwitch ? "Release platform kill switch" : "Platform kill switch"}</Button>} />
    <ErrorNote msg={e2} />
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat icon={ArrowLeftRight} label="Settled volume" value={usd(k.settledVolume)} hint={`${k.settledCount} payments, average ${usd(k.avgTicket)}`} />
      <Stat icon={BadgeDollarSign} label="Bank net revenue" value={usd(k.netRevenue)} hint={`${usd(k.bankFees)} in bank fees`} />
      <Stat icon={ShieldAlert} label="Blocked by policy or screening" value={k.blockedCount} hint={`${k.blockedRate} percent of ${k.payments} payments`} />
      <Stat icon={Activity} label="In flight" value={k.inFlight} hint={k.medianSettleMinutes !== null ? `Median settle ${k.medianSettleMinutes} minutes` : "No settlements yet"} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat icon={ShieldAlert} label="Open sanctions cases" value={k.openSanctions} />
      <Stat label="Open disputes" value={k.openDisputes} />
      <Stat icon={Scale} label="Open recon exceptions" value={k.openExceptions} />
      <Stat icon={Bot} label="Active agents" value={k.activeAgents} hint={k.killSwitch ? "Kill switch is on" : undefined} />
    </div>
    <HomeStrip />
    <MoneyFlowMap />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card title="Settled volume by day"><div className="h-52"><ResponsiveContainer><BarChart data={k.daily}><CartesianGrid stroke={col.grid} vertical={false} /><XAxis dataKey="day" tick={{ ...axis, fill: col.muted }} tickFormatter={(d) => d.slice(5)} interval={6} /><YAxis tick={{ ...axis, fill: col.muted }} width={48} /><Tooltip {...tip} formatter={(v: any) => [usd(Number(v)), "Settled"]} /><Bar dataKey="volume" fill={col.primary} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div></Card>
      <Card title="Volume by rail" pad={false}>{k.byRail.length ? <Table>{k.byRail.map((r: any) => <tr key={r.rail}><td>{railName(r.rail)}</td><td className="text-right tabular-nums">{usd(r.volume)}</td></tr>)}</Table> : <EmptyState title="No settled payments yet" />}</Card>
    </div>
    <PaymentsTable title="Latest payments" />
  </Section>;
}

export function RevenuePage() {
  const { data, error } = useGet<any>("/ops/revenue"); const col = useChartColors();
  if (!data) return <Loading error={error as Error} />;
  const t = data.totals;
  const byMonth = Object.values(data.rows.reduce((m: any, r: any) => { (m[r.month] ??= { month: r.month, bankFees: 0, railFees: 0 }); m[r.month].bankFees += r.bankFees; m[r.month].railFees += r.railFees; return m; }, {})).reverse();
  return <Section>
    <PageHeader title="Revenue" sub="Bank fees charged to clients, minus what each rail costs. From settled payments only." />
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Stat label="Settled volume" value={usd(t.volume)} hint={`${t.count} payments`} /><Stat label="Bank fees" value={usd(t.bankFees)} /><Stat label="Rail costs" value={usd(t.railFees)} /><Stat label="Net revenue" value={usd(t.net)} hint={t.refunds ? `${usd(t.refunds)} refunded` : undefined} /></div>
    {byMonth.length > 0 && <Card title="By month"><div className="h-48"><ResponsiveContainer><BarChart data={byMonth}><CartesianGrid stroke={col.grid} vertical={false} /><XAxis dataKey="month" tick={{ ...axis, fill: col.muted }} /><YAxis tick={{ ...axis, fill: col.muted }} width={48} /><Tooltip {...tip} formatter={(v: any, n: any) => [usd(Number(v)), n === "bankFees" ? "Bank fees" : "Rail costs"]} /><Bar dataKey="bankFees" fill={col.primary} /><Bar dataKey="railFees" fill={col.accent} /></BarChart></ResponsiveContainer></div></Card>}
    <Card title="By tenant, rail and month" pad={false}>{data.rows.length ? <Table head={["Month", "Tenant", "Bank", "Rail", "Payments", "Volume", "Rail cost", "Bank fee", "Net", "Refunded"]}>{data.rows.map((r: any) => <tr key={`${r.tenantId}${r.rail}${r.month}`}><td>{r.month}</td><td>{r.tenant}</td><td>{r.bank}</td><td>{railName(r.rail)}</td><td className="tabular-nums">{r.count}</td><td className="tabular-nums">{usd(r.volume)}</td><td className="tabular-nums">{usd(r.railFees)}</td><td className="tabular-nums">{usd(r.bankFees)}</td><td className="tabular-nums font-medium">{usd(r.net)}</td><td className="tabular-nums">{r.refunds ? usd(r.refunds) : ""}</td></tr>)}</Table> : <EmptyState icon={BadgeDollarSign} title="No revenue yet" body="Revenue shows once a payment settles on a rail." />}</Card>
    <Card title="Bank pricing" pad={false}><Table head={["Bank", "Card", "ACH", "USDC Circle", "USDC Base"]}>{data.pricing.map((p: any) => <tr key={p.bank}><td>{p.bank}</td>{["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"].map((r) => <td key={r} className="tabular-nums">{p.pricing[r] ? `${p.pricing[r].pct} percent${p.pricing[r].fixed ? ` plus ${usd(p.pricing[r].fixed)}` : ""}` : "None"}</td>)}</tr>)}</Table></Card>
  </Section>;
}

function Secret({ v, onDone }: { v: string; onDone: () => void }) {
  return <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px]"><span className="font-medium">Shown once. Copy it now.</span><Mono className="break-all">{v}</Mono><Button size="sm" onClick={() => navigator.clipboard?.writeText(v).catch(() => undefined)}><Copy size={13} />Copy</Button><Button size="sm" variant="ghost" onClick={onDone}>Done</Button></div>;
}
export function DevelopersPage() {
  const { data: me } = useMe(); const picker = useClientPicker();
  const operator = !!me?.operator; const tenantId = operator ? picker.tenantId : me?.tenant.id;
  const q = operator ? `?tenantId=${tenantId}` : "";
  const keys = useGet<any[]>(`/dev/keys${q}`, !!tenantId); const hooks = useGet<any>(`/dev/webhooks${q}`, !!tenantId); const events = useGet<any[]>(`/dev/events${q}`, !!tenantId); const tools = useGet<{ tools: any[] }>("/mcp/tools");
  const { run, busy, error } = useAct(); const [secret, setSecret] = useState(""); const [label, setLabel] = useState(""); const [role, setRole] = useState("auditor"); const [url, setUrl] = useState(""); const [types, setTypes] = useState<string[]>([]);
  const body = (x: object) => (operator ? { ...x, tenantId } : x);
  return <Section>
    <PageHeader title="Developers" sub="API keys, webhook endpoints and the event log for one business client" actions={operator && picker.pick} />
    <ErrorNote msg={error} />{secret && <Secret v={secret} onDone={() => setSecret("")} />}
    <Card title={<span className="flex items-center gap-2"><KeyRound size={14} />API keys</span>}>
      <div className="flex flex-wrap items-end gap-2"><div><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ERP sync" /></div><div><Label>Access</Label><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="auditor">Read only</option><option value="ap_clerk">AP clerk, can pay</option></Select></div>
        <Button variant="primary" disabled={busy || !label} onClick={async () => { const r = await run(() => api(`/dev/keys`, body({ label, role }))); if (r) { setSecret(r.key); setLabel(""); } }}>Create key</Button></div>
      <Muted className="mt-1 block">Send it as Authorization: Bearer bpk_test_... Only a hash is stored.</Muted>
      {keys.data?.length ? <Table className="mt-3" head={["Key", "Label", "Access", "Created", "Last used", ""]}>{keys.data.map((k) => <tr key={k.id}><td><Mono>{k.prefix}...</Mono></td><td>{k.label}</td><td>{k.role === "auditor" ? "Read only" : "AP clerk"}</td><td><Muted>{k.createdAt.slice(0, 10)} by {k.createdBy}</Muted></td><td><Muted>{k.lastUsedAt?.slice(0, 16).replace("T", " ") ?? "Never"}</Muted></td>
        <td className="text-right">{k.revokedAt ? <Badge v="revoked" /> : <Button size="sm" disabled={busy} onClick={() => run(() => api(`/dev/keys/${k.id}/revoke`, body({})))}>Revoke</Button>}</td></tr>)}</Table> : null}
    </Card>
    <Card title={<span className="flex items-center gap-2"><Webhook size={14} />Webhook endpoints</span>}>
      <div className="flex flex-col gap-2"><div className="flex flex-wrap gap-2"><Input className="min-w-72 flex-1" value={url} onChange={(e) => setUrl(e.target.value.trim())} placeholder="https://erp.example.com/hooks/b2bpay" /><Button variant="primary" disabled={busy || !url} onClick={async () => { const r = await run(() => api("/dev/webhooks", body({ url, events: types }))); if (r) { setSecret(r.secret); setUrl(""); } }}>Add endpoint</Button></div>
        <div className="flex flex-wrap gap-1">{(hooks.data?.eventTypes ?? []).map((t: string) => { const on = types.includes(t); return <button key={t} type="button" aria-pressed={on} onClick={() => setTypes(on ? types.filter((x) => x !== t) : [...types, t])} className={on ? "rounded-full bg-primary px-2.5 py-1 text-[11px] text-white" : "rounded-full border border-border px-2.5 py-1 text-[11px] text-muted"}>{t}</button>; })}</div>
        <Muted>No events picked means all events. Each delivery is signed: header x-b2bpay-signature is t=timestamp,v1=HMAC SHA256 of timestamp.body with the endpoint secret. Failed deliveries retry after {(hooks.data?.backoffSec ?? []).map((s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`)).join(", ")}.</Muted></div>
      {hooks.data?.endpoints.length ? <Table className="mt-3" head={["Endpoint", "Events", "Deliveries", ""]}>{hooks.data.endpoints.map((e: any) => <tr key={e.id}><td><Mono className="break-all">{e.url}</Mono>{!e.active && <Badge v="paused" tone="neutral" className="ml-1" />}</td><td><Muted>{e.events.length ? e.events.join(", ") : "All"}</Muted></td><td>{e.stats.map((s: any) => <Badge key={s.status} v={`${s.status} ${s.n}`} className="mr-1" tone={s.status === "failed" ? "bad" : s.status === "pending" ? "warn" : "ok"} />)}</td>
        <td className="flex justify-end gap-1"><Button size="sm" disabled={busy} onClick={() => run(() => api(`/dev/webhooks/${e.id}/test`, body({})))}>Send test</Button><Button size="sm" disabled={busy} onClick={() => run(() => api(`/dev/webhooks/${e.id}/active`, body({ active: !e.active })))}>{e.active ? "Pause" : "Resume"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm("Delete this endpoint?") && run(() => api(`/dev/webhooks/${e.id}${q}`, undefined, { method: "DELETE" }))}>Delete</Button></td></tr>)}</Table> : null}
    </Card>
    <Card title="Event log" pad={false}>{events.data?.length ? <Table head={["Event", "Type", "When", "Deliveries"]}>{events.data.map((e) => <tr key={e.id}><td><Mono>{e.id}</Mono></td><td>{e.type}</td><td><Muted>{e.createdAt.slice(0, 19).replace("T", " ")}</Muted></td>
      <td>{e.deliveries.length ? e.deliveries.map((d: any) => <div key={d.id} className="flex flex-wrap items-center gap-1"><Badge v={d.status} tone={d.status === "failed" ? "bad" : d.status === "pending" ? "warn" : "ok"} /><Muted>{d.attempts} tries{d.lastStatus ? `, last HTTP ${d.lastStatus}` : ""}{d.lastError ? `, ${d.lastError}` : ""}{d.status === "pending" ? `, next ${d.nextAt.slice(11, 19)}` : ""}</Muted>{d.status === "failed" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api(`/dev/deliveries/${d.id}/retry`, body({})))}>Retry</Button>}</div>) : <Muted>No endpoint subscribed</Muted>}</td></tr>)}</Table> : <EmptyState title="No events yet" body="Settled and failed payments, approved POs, verified suppliers and new cases all post events here." />}</Card>
    <Card title="Agent gateway tools (MCP)" pad={false}><Table>{(tools.data?.tools ?? []).map((x) => <tr key={x.name}><td><Mono>{x.name}</Mono></td><td><Muted>{x.description}</Muted></td></tr>)}</Table></Card>
  </Section>;
}
