import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Building, Lock } from "lucide-react";
import { api, useAct, useGet } from "../lib/api";
import { Badge, Button, Card, EmptyState, ErrorNote, Mono, Muted, PageHeader, Select, Stat, Table } from "../components/ui";
import { Section } from "../components/Shell";

export type Entity = { id: string; tenantId: string; name: string; currency: string; country: string; isDefault: boolean; journals?: number; balanced?: boolean; cash?: number };
const KEY = "b2b.entity";
const EVT = "b2b-entity-change";
const read = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
export const money = (n: number | null | undefined, c = "USD") => `${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`;

/** The entity the client workspace is looking at. Shared across pages, kept per browser. */
export function useEntity() {
  const { data: ents } = useGet<Entity[]>("/entities");
  const [id, setId] = useState(read());
  useEffect(() => { const on = () => setId(read()); window.addEventListener(EVT, on); return () => window.removeEventListener(EVT, on); }, []);
  const set = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked */ } setId(v); window.dispatchEvent(new Event(EVT)); };
  const cur = ents?.find((e) => e.id === id) ?? ents?.find((e) => e.isDefault) ?? ents?.[0];
  return { entities: ents ?? [], entity: cur, setEntity: set };
}

export function EntitySwitcher() {
  const { entities, entity, setEntity } = useEntity();
  if (!entities.length) return null;
  return <label className="flex items-center gap-1.5 text-[13px]" title="Legal entity">
    <Building size={14} className="text-muted" aria-hidden /><span className="sr-only">Legal entity</span>
    <Select aria-label="Legal entity" className="h-8 w-auto py-0 text-[13px]" value={entity?.id ?? ""} onChange={(e) => setEntity(e.target.value)}>
      {entities.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.currency})</option>)}
    </Select>
  </label>;
}

/** Entity ledger: books in the functional currency, balances per transaction currency, FX locks and gains. */
export function EntityLedgerPage() {
  const { entity } = useEntity();
  const { data: l, error } = useGet<any>(entity ? `/entities/${entity.id}/ledger` : "", !!entity);
  const { run, busy, error: actErr } = useAct();
  const [ccy, setCcy] = useState("EUR");
  if (!entity) return <Section><PageHeader title="Entity ledger" /><EmptyState title="No legal entities" /></Section>;
  const accounts = l ? Object.entries(l.trialBalance.accounts) as [string, any][] : [];
  const byCcy = l ? Object.entries(l.byCurrency) as [string, Record<string, number>][] : [];
  const fxPays = (l?.payments ?? []).filter((p: any) => p.fx);
  return <Section>
    <PageHeader title="Entity ledger" sub={`${entity.name} keeps its books in ${entity.currency}. Every journal balances inside this entity.`} actions={<div className="flex items-center gap-2"><EntitySwitcher /></div>} />
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat label="Functional currency" value={entity.currency} hint={entity.country} />
      <Stat label="Journals" value={l?.journals.length ?? 0} />
      <Stat label="Books" value={l ? (l.balanced ? "Balanced" : "Unbalanced") : "Loading"} hint={l ? `Debits ${money(l.trialBalance.totalDebit, entity.currency)}, credits ${money(l.trialBalance.totalCredit, entity.currency)}` : undefined} />
    </div>
    <Card title="Try a foreign currency order" className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Invoice currency" className="w-auto" value={ccy} onChange={(e) => setCcy(e.target.value)}>{["EUR", "GBP", "USD"].map((c) => <option key={c}>{c}</option>)}</Select>
        <Button disabled={busy} onClick={() => run(() => api("/scenario/run", { need: "Need 50 sealed 6204 bearings", scenario: "happy", entityId: entity.id, currency: ccy }))}>Run test order in {entity.name}</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(() => api("/payments/poll", {}))}>Check settlements</Button>
      </div>
      <Muted>Sandbox only. No real money moves. The rate comes from Frankfurter (ECB reference rates) and is locked when the payment is approved.</Muted>
      <ErrorNote msg={actErr || (error as Error | undefined)?.message} />
    </Card>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card title={`Trial balance in ${entity.currency}`} action={l && <Badge v={l.balanced ? "balanced" : "unbalanced"} />}>
        {accounts.length ? <Table head={["Account", "Debit", "Credit", "Balance"]}>{accounts.map(([k, v]) => <tr key={k}><td>{k}</td><td className="tabular-nums">{money(v.debit, entity.currency)}</td><td className="tabular-nums">{money(v.credit, entity.currency)}</td><td className="font-semibold tabular-nums">{money(v.balance, entity.currency)}</td></tr>)}</Table> : <EmptyState title="No postings yet" />}
      </Card>
      <Card title="Balances per currency">
        {byCcy.length ? byCcy.map(([c, rows]) => <div key={c} className="mb-3"><div className="mb-1 text-xs font-medium">{c}</div><Table head={["Account", "Balance"]}>{Object.entries(rows).map(([a, v]) => <tr key={a}><td>{a}</td><td className="tabular-nums">{money(v, c)}</td></tr>)}</Table></div>) : <EmptyState title="No balances yet" />}
        <Muted>Amounts in the currency the money was really in. The trial balance shows the same lines in {entity.currency}.</Muted>
      </Card>
    </div>
    <Card title="FX locks and realised FX" className="mt-4" pad={false}>
      {fxPays.length ? <Table head={["Payment", "Invoice", "Settled", "Locked rate", "Realised FX"]}>{fxPays.map((p: any) => <tr key={p.id}>
        <td><Link className="text-primary hover:underline" to={`/app/payments/${p.id}`}><Mono>{p.id}</Mono></Link><div><Badge v={p.status} /></div></td>
        <td className="tabular-nums">{money(p.fx.invoiceAmount, p.fx.invoiceCurrency)}</td><td className="tabular-nums">{money(p.fx.settlementAmount, "USD")}</td>
        <td><Mono>{p.fx.rate}</Mono>{p.fx.stale && <Badge v="stale rate" tone="warn" className="ml-1" />}<div><Muted>{p.fx.lockId}</Muted></div></td>
        <td>{p.fx.realised ? p.fx.realised.kind === "none" ? "None" : <Badge v={`${p.fx.realised.kind} ${money(Math.abs(p.fx.realised.gainLoss), entity.currency)}`} tone={p.fx.realised.kind === "gain" ? "ok" : "bad"} /> : <Muted>On settlement</Muted>}</td>
      </tr>)}</Table> : <div className="p-4"><EmptyState title="No FX payments in this entity" /></div>}
    </Card>
    <Card title="Journal entries" className="mt-4" pad={false}>
      {l?.journals.length ? <Table head={["Journal", "Account", "Debit", "Credit", "Original"]}>{[...l.journals].reverse().flatMap((j: any) => j.entries.map((e: any, k: number) => <tr key={e.id}><td>{k === 0 ? <><Mono>{j.id}</Mono><div><Muted>{j.memo}</Muted></div></> : ""}</td><td>{e.account}</td><td className="tabular-nums">{e.debit ? money(e.debit, e.currency) : ""}</td><td className="tabular-nums">{e.credit ? money(e.credit, e.currency) : ""}</td><td>{e.origCurrency ? <Muted>{money(e.origAmount, e.origCurrency)}</Muted> : ""}</td></tr>))}</Table> : <div className="p-4"><EmptyState title="No journals yet" /></div>}
    </Card>
  </Section>;
}

/** FX quote and lock on the payment detail page. */
export function FxCard({ id }: { id: string }) {
  const { data } = useGet<any>(`/payments/${id}`, !!id);
  const fx = data?.intent?.fx;
  if (!data) return null;
  if (!fx) return <Card title="FX"><Muted>Invoice and entity are both in USD. No conversion was needed.</Muted></Card>;
  return <Card title="FX quote and lock" action={<div className="flex gap-1">{fx.stale && <Badge v="stale rate" tone="warn" />}<Badge v={fx.realised ? "settled at lock" : "locked"} tone="primary" /></div>}>
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat label="Invoice" value={money(fx.invoiceAmount, fx.invoiceCurrency)} />
      <Stat label="Settles" value={money(fx.settlementAmount, "USD")} hint={`Rate ${fx.rate}`} />
      <Stat label="Realised FX" value={fx.realised ? (fx.realised.kind === "none" ? "None" : `${fx.realised.kind} ${money(Math.abs(fx.realised.gainLoss), fx.functionalCurrency)}`) : "On settlement"} />
    </div>
    <ul className="mt-3 space-y-1 text-xs text-muted">
      <li className="flex items-center gap-1.5"><Lock size={12} aria-hidden />Lock <Mono>{fx.lockId}</Mono> from {new Date(fx.lockedAt).toLocaleString()} until {new Date(fx.expiresAt).toLocaleString()}</li>
      <li>Source {fx.source}{fx.rateDate ? `, rate date ${fx.rateDate}` : ""}. Fetched {new Date(fx.fetchedAt).toLocaleString()}.{fx.stale ? " The source was offline, so this is the last cached rate." : ""}</li>
      <li>Functional rate {fx.invoiceCurrency} to {fx.functionalCurrency}: {fx.functionalRate}</li>
    </ul>
  </Card>;
}
