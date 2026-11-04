import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeftRight, BadgeDollarSign, Building2, Code2, ShieldAlert, Upload } from "lucide-react";
import { api, useAct, useAppState, useGet, useMe, type Branding, type Tenant } from "../lib/api";
import { applyTheme } from "../lib/theme";
import { usd } from "../lib/utils";
import { Badge, Button, Card, DataTable, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Stat, Table } from "../components/ui";
import { Logo, Section } from "../components/Shell";
import * as F from "./flows";
import * as Ops from "./ops";
import * as In from "./insights";
import { ScimTokens } from "./iam";
import { PaymentsTable, RailStatus, type RailRow } from "./payments";

export const OperatorHome = In.OperatorHome;

export function OperatorPayments() { const { data: st, error } = useAppState(); return <Section><PageHeader title="Payments" sub="Every payment across tenants. Status updates live from webhooks and the settlement watcher." /><RailStatus /><PaymentsTable />{st ? <F.Settlements st={st} /> : <F.Loading error={error as Error} />}</Section>; }

export function Tenants() {
  const { data } = useGet<Tenant[]>("/tenants");
  const cols = useMemo<ColumnDef<Tenant>[]>(() => [
    { header: "Name", accessorKey: "name", cell: (c) => <span className="flex items-center gap-2"><Logo name={c.row.original.branding.name} logo={c.row.original.branding.logo} size={20} />{c.getValue<any>()}</span> },
    { header: "Type", accessorKey: "kind", cell: (c) => <Badge v={c.getValue<any>() === "bank" ? "bank" : "business client"} tone="neutral" /> },
    { header: "Bank", accessorKey: "parentId", cell: (c) => <Mono>{c.getValue<any>() ?? ""}</Mono> },
    { header: "Rails", id: "rails", enableSorting: false, cell: (c) => <span className="flex flex-wrap gap-1">{Object.entries(c.row.original.railSettings).map(([r, s]) => <Badge key={r} v={`${r} ${s.env === "live" ? "LIVE" : "TEST"}`} tone={s.env === "live" ? "bad" : "neutral"} />)}</span> },
    { header: "Created", accessorKey: "createdAt", cell: (c) => <Muted>{String(c.getValue<any>()).slice(0, 10)}</Muted> },
  ], []);
  return <Section><PageHeader title="Tenants" sub="Banks you white label for and their business clients" /><Card pad={false}><DataTable data={data ?? []} columns={cols} /></Card></Section>;
}

export const Compliance = Ops.CompliancePage;
export const Treasury = Ops.TreasuryPage;
export const Recon = Ops.ReconPage;
export const Revenue = In.RevenuePage;
export const Developers = () => <Section><In.DevelopersPage /><ScimTokens /></Section>;

export function BrandingPage() {
  const { data: me } = useMe(); const { data: tenants } = useGet<Tenant[]>("/tenants");
  const banks = (tenants ?? []).filter((t) => t.kind === "bank");
  const [id, setId] = useState<string>(""); const t = banks.find((b) => b.id === id) ?? banks[0];
  const [form, setForm] = useState<Branding | null>(null);
  const { run, busy, error, setError } = useAct(); const file = useRef<HTMLInputElement>(null); const preview = useRef<HTMLDivElement>(null);
  useEffect(() => { if (t) setForm(t.branding); }, [t?.id, t?.branding]);
  useEffect(() => { if (form && preview.current) applyTheme(form, preview.current); }, [form]);
  if (!t || !form) return <F.Loading />;
  const upload = (f: File) => { if (f.size > 1_000_000) { setError("Logo must be under 1 MB"); return; } const r = new FileReader(); r.onload = async () => { const res = await run(() => api<{ logo: string }>(`/tenants/${t.id}/logo`, { dataUrl: r.result })); if (res) setForm({ ...form, logo: res.logo }); }; r.readAsDataURL(f); };
  const save = () => run(() => api(`/tenants/${t.id}/branding`, form, { method: "PATCH" }));
  return <Section>
    <PageHeader title="Branding" sub="Each bank's name, colours and logo. Business clients inherit their bank's brand." actions={<Select value={t.id} onChange={(e) => setId(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>} />
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      <Card title="Brand settings">
        <div className="flex flex-col gap-3">
          <div><Label>Display name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          {(["primary", "accent"] as const).map((k) => <div key={k}><Label>{k === "primary" ? "Primary colour" : "Accent colour"}</Label><div className="flex gap-2"><input type="color" aria-label={`${k} colour`} className="h-8 w-10 rounded border border-border bg-surface" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /><Input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></div></div>)}
          <div><Label>Logo</Label><div className="flex items-center gap-2"><Logo name={form.name} logo={form.logo} size={36} /><Button size="sm" onClick={() => file.current?.click()}><Upload size={13} />Upload</Button>{form.logo && <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, logo: null })}>Remove</Button>}</div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></div>
          <ErrorNote msg={error} />
          <div className="flex gap-2"><Button variant="primary" disabled={busy} onClick={save}>Save branding</Button><Button disabled={busy} onClick={() => setForm(t.branding)}>Discard</Button></div>
          {me?.tenant.id !== t.id && <Muted>Switch to this bank in the tenant menu to see the theme across the console.</Muted>}
        </div>
      </Card>
      <Card title="Live preview">
        <div ref={preview} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2"><Logo name={form.name} logo={form.logo} size={22} /><b>{form.name}</b><span className="ml-auto rounded bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">TEST</span></div>
          <div className="flex"><div className="w-40 border-r border-border bg-subtle p-2 text-xs">{["Home", "Purchase orders", "Approvals", "Payments"].map((n, i) => <div key={n} className={i === 0 ? "rounded bg-primary/10 px-2 py-1 font-medium text-primary" : "px-2 py-1 text-muted"}>{n}</div>)}</div>
            <div className="flex-1 p-4"><div className="text-sm font-semibold">Approvals inbox</div><div className="mt-2 rounded-lg border border-border p-3"><div className="text-[13px]">Northwind Components $13,500.00</div><div className="mt-2 flex gap-2"><span className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-fg">Approve</span><span className="rounded-md border border-border px-2.5 py-1 text-xs">Reject</span><span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] text-accent-fg">Agent</span></div></div></div></div>
        </div>
      </Card>
    </div>
  </Section>;
}

export function SettingsPage() {
  const { data: me } = useMe(); const { data: tenants } = useGet<Tenant[]>("/tenants"); const { data: changes } = useGet<any[]>("/changes");
  const { data: rails } = useGet<RailRow[]>("/rails");
  const { run, busy, error } = useAct();
  const [tid, setTid] = useState("tnt-acme"); const t = tenants?.find((x) => x.id === tid);
  const request = (rail: string, env: string) => run(() => api("/changes", { kind: "rail.settings", tenantId: tid, payload: { tenantId: tid, rail, setting: { env } } }));
  return <Section>
    <PageHeader title="Settings" sub="Sandbox or Live for each rail and tenant. Every change needs a second operator to approve." actions={<Select value={tid} onChange={(e) => setTid(e.target.value)}>{(tenants ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>} />
    <ErrorNote msg={error} />
    <Card title="Rails" pad={false}>{t && rails ? <Table head={["Rail", "Keys", "Environment", ""]}>{rails.map((r) => { const env = t.railSettings[r.rail]?.env ?? "sandbox"; const next = env === "live" ? "sandbox" : "live";
      return <tr key={r.rail}><td className="font-medium">{r.label}</td>
        <td>{r.configured ? <Badge v="Ready" tone="ok" /> : <span className="flex flex-col"><Badge v="Not configured" tone="bad" className="w-fit" /><Muted>{r.notConfiguredReason}</Muted></span>}</td>
        <td><Badge v={env === "live" ? "LIVE" : "SANDBOX"} tone={env === "live" ? "bad" : "neutral"} /></td>
        <td className="text-right"><Button size="sm" disabled={busy} onClick={() => request(r.rail, next)}>Request switch to {next}</Button></td></tr>; })}</Table> : <F.Loading />}
      <p className="px-4 py-2 text-xs text-muted">Live is refused unless the matching live keys are set in the server .env file. Rails without keys are skipped by the router.</p></Card>
    <Card title="Changes waiting for a checker" pad={false}>{changes?.length ? <Table head={["Change", "Kind", "Detail", "Maker", "Status", ""]}>{changes.map((c) => <tr key={c.id}><td><Mono>{c.id}</Mono></td><td>{c.kind}</td><td><Mono>{c.payload.tenantId} {c.payload.rail} {c.payload.setting?.env}</Mono></td><td>{c.requestedBy}</td><td><Badge v={c.status} /></td>
      <td className="flex justify-end gap-1">{c.status === "pending" && (c.requestedBy === me?.user.id ? <Muted>Another operator must approve</Muted> : <><Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api(`/changes/${c.id}/decide`, { approve: true }))}>Approve</Button><Button size="sm" disabled={busy} onClick={() => run(() => api(`/changes/${c.id}/decide`, { approve: false }))}>Reject</Button></>)}</td></tr>)}</Table>
      : <EmptyState title="No pending changes" body="Requests for rail or environment changes wait here for a second operator." />}</Card>
  </Section>;
}
