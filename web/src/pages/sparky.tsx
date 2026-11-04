import { useState } from "react";
import { useParams } from "react-router-dom";
import { Bot, Gift, KeyRound, LayoutList, Send, Store } from "lucide-react";
import { api, useAct, useGet } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, Stat, Table } from "../components/ui";

/** MCP tokens on the Developers page. Scoped to read-only tools, with an expiry, shown once, revocable. */
export function McpTokens({ tenantId }: { tenantId?: string }) {
  const q = tenantId ? `?tenantId=${tenantId}` : "";
  const { data } = useGet<{ tokens: any[]; tools: string[] }>(`/dev/mcp-tokens${q}`, true);
  const { run, busy, error } = useAct(); const [label, setLabel] = useState(""); const [days, setDays] = useState("30"); const [pick, setPick] = useState<string[]>([]); const [shown, setShown] = useState("");
  const body = (x: object) => (tenantId ? { ...x, tenantId } : x);
  return <Card title={<span className="flex items-center gap-2"><KeyRound size={14} />MCP server tokens</span>}>
    <ErrorNote msg={error} />
    {shown && <div role="status" className="mb-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-[13px]"><span className="font-medium">Shown once. Copy it now. </span><Mono className="break-all">{shown}</Mono> <Button size="sm" variant="ghost" onClick={() => setShown("")}>Done</Button></div>}
    <div className="flex flex-wrap items-end gap-2"><div><Label>Label</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude desktop" /></div>
      <div><Label>Expires in days</Label><Input aria-label="Expires in days" type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" /></div>
      <Button variant="primary" disabled={busy || !label} onClick={async () => { const r = await run(() => api("/dev/mcp-tokens", body({ label, days: Number(days), tools: pick }))); if (r) { setShown(r.token); setLabel(""); } }}>Create token</Button></div>
    <div className="mt-2 flex flex-wrap gap-1" aria-label="Tool scope">{(data?.tools ?? []).map((t) => { const on = pick.includes(t); return <button key={t} type="button" aria-pressed={on} onClick={() => setPick(on ? pick.filter((x) => x !== t) : [...pick, t])} className={on ? "rounded-full bg-primary px-2.5 py-1 text-[11px] text-primary-fg" : "rounded-full border border-border px-2.5 py-1 text-[11px] text-muted"}>{t}</button>; })}</div>
    <Muted className="mt-1 block">No tools picked means every read-only tool. There are no write tools. Endpoint POST /api/mcp (streamable HTTP) with Authorization: Bearer mcp_test_..., or the stdio script. Each call is rate limited and lands in the evidence chain.</Muted>
    {data?.tokens.length ? <Table className="mt-3" head={["Token", "Label", "Tools", "Expires", "Calls", ""]}>{data.tokens.map((t) => <tr key={t.id}><td><Mono>{t.prefix}...</Mono></td><td>{t.label}</td><td><Muted>{t.tools.length} tools</Muted></td><td><Muted>{t.expiresAt.slice(0, 10)}</Muted></td><td>{t.calls}</td>
      <td className="text-right">{t.revokedAt ? <Badge v="revoked" /> : t.expiresAt < new Date().toISOString() ? <Badge v="expired" /> : <Button size="sm" disabled={busy} onClick={() => run(() => api(`/dev/mcp-tokens/${t.id}/revoke`, body({})))}>Revoke</Button>}</td></tr>)}</Table> : null}
  </Card>;
}

/** Operator home: bank ops agent view, copilot adoption and per client offer switches. */
export function OpsAgentPanel() {
  const { data: v } = useGet<any>("/ops/agent-view"); const { data: m } = useGet<any>("/ops/copilot-metrics"); const { data: offers } = useGet<any[]>("/ops/offers");
  const { run, busy, error } = useAct(); const pct = (x: number | null) => (x === null || x === undefined ? "No data" : `${x} percent`);
  return <>
    <Card title={<span className="flex items-center gap-2"><LayoutList size={14} />Bank ops agent</span>}>
      {!v ? <Muted>Loading</Muted> : <div className="grid gap-3 lg:grid-cols-2">
        <Table head={["Queue", "Open"]}>{v.queues.map((q: any) => <tr key={q.queue}><td>{q.queue}</td><td><Badge v={String(q.count)} tone={q.count ? "warn" : "ok"} /></td></tr>)}</Table>
        <div>{v.tasks.length ? <Table head={["Task", "Client"]}>{v.tasks.slice(0, 8).map((t: any) => <tr key={t.id + t.task}><td>{t.task} <Mono className="text-muted">{t.id}</Mono></td><td><Mono>{t.tenantId ?? "platform"}</Mono></td></tr>)}</Table> : <EmptyState title="No open tasks" body="Escalations, operator changes and recon exceptions show here." />}</div>
      </div>}
      <Muted className="mt-2 block">Ask the copilot: Show the ops queues and risk escalations.</Muted>
    </Card>
    <Card title={<span className="flex items-center gap-2"><Bot size={14} />Copilot adoption</span>}>
      {m ? <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Questions" value={m.questions} hint={`${m.users} users, ${m.mcpCalls} MCP calls`} />
        <Stat label="Accepted proposals" value={m.accepted} hint={`${m.proposed} proposed, ${pct(m.acceptRate)}`} />
        <Stat label="Thumbs up ratio" value={pct(m.thumbsRatio)} hint={`${m.thumbsUp} up, ${m.thumbsDown} down`} />
        <Stat label="Time to approve" value={m.medianMinutesToApprove === null ? "No data" : `${m.medianMinutesToApprove} min`} hint="Median, answer to confirmed approval" />
        <Stat label="Straight through" value={pct(m.straightThrough)} hint={`${m.paidOrders} paid orders`} />
      </div> : <Muted>Loading</Muted>}
    </Card>
    <Card title={<span className="flex items-center gap-2"><Gift size={14} />Bank offers in copilot answers</span>}>
      <ErrorNote msg={error} />
      <Muted className="mb-2 block">Off by default for new clients. When on, answers can show an FX forward or a credit line labelled Offer, only when the client data triggers it. Offers never act.</Muted>
      <Table head={["Client", "Offers", ""]}>{(offers ?? []).map((o) => <tr key={o.tenantId}><td>{o.name} <Mono className="text-muted">{o.tenantId}</Mono></td><td><Badge v={o.enabled ? "On" : "Off"} tone={o.enabled ? "primary" : "neutral"} /></td>
        <td className="text-right"><Button size="sm" disabled={busy} onClick={() => run(() => api(`/ops/offers/${o.tenantId}`, { enabled: !o.enabled }))}>{o.enabled ? "Switch off" : "Switch on"}</Button></td></tr>)}</Table>
    </Card>
  </>;
}

/** Public supplier portal with a read-only supplier agent. The link token is the only credential. */
export function SupplierPortal() {
  const { token = "" } = useParams(); const { data: d, error } = useGet<any>(`/supplier-portal/${token}`);
  const [q, setQ] = useState(""); const [turns, setTurns] = useState<any[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const ask = async (text: string) => { const t = text.trim(); if (!t) return; setBusy(true); setErr(""); setQ(""); try { const r = await api(`/supplier-portal/${token}/ask`, { question: t }); setTurns((x) => [...x, r]); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  if (error) return <div className="grid min-h-screen place-items-center bg-bg p-4"><EmptyState icon={Store} title="This link does not work" body={(error as Error).message} /></div>;
  if (!d) return <div className="min-h-screen bg-bg p-4"><Muted>Loading</Muted></div>;
  return <div className="min-h-screen bg-bg p-4"><div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-6">
    <div><h1 className="text-lg font-semibold">{d.supplier.name}</h1><Muted>Supplier portal for {d.buyer}. You see only your own invoices, payments and onboarding.</Muted></div>
    <div className="grid gap-3 sm:grid-cols-3"><Stat label="Onboarding" value={d.onboarding.status} hint={`Screening ${d.onboarding.screening}`} /><Stat label="Open invoices" value={d.invoices.filter((i: any) => !i.paid).length} hint={`${d.invoices.length} in total`} /><Stat label="Payments" value={d.payments.length} hint={d.onboarding.onHold ? "Paused by the buyer for review" : `Bank ${d.onboarding.bank}`} /></div>
    <Card title="Your invoices" pad={false}>{d.invoices.length ? <Table head={["Invoice", "Amount", "Due", "Match", "Paid"]}>{d.invoices.map((i: any) => <tr key={i.invoiceId}><td>{i.number} <Mono className="text-muted">{i.invoiceId}</Mono></td><td>{Number(i.amount).toFixed(2)} {i.currency}</td><td>{i.dueDate}</td><td><Badge v={i.match} /></td><td><Badge v={i.paid ? "paid" : "open"} tone={i.paid ? "ok" : "warn"} /></td></tr>)}</Table> : <EmptyState title="No invoices yet" />}</Card>
    <Card title="Your payments" pad={false}>{d.payments.length ? <Table head={["Payment", "Amount", "Status", "Rail"]}>{d.payments.map((p: any) => <tr key={p.paymentId}><td><Mono>{p.paymentId}</Mono></td><td>{usd(p.amount)}</td><td><Badge v={p.status} /></td><td>{p.rail ?? ""}</td></tr>)}</Table> : <EmptyState title="No payments yet" />}</Card>
    <Card title={<span className="flex items-center gap-2"><Bot size={14} />Ask about your account</span>}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">{d.suggest.map((s: string) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-subtle">{s}</button>)}</div>
        {turns.map((t) => <div key={t.id} className="flex flex-col gap-1"><div className="self-end rounded-xl bg-primary px-3 py-2 text-[13px] text-primary-fg">{t.question}</div><div className="rounded-xl bg-subtle px-3 py-2 text-[13px]">{t.refused && <span className="mb-1 block text-[11px] font-medium text-warn">No source found</span>}{t.answer}</div></div>)}
        <ErrorNote msg={err} />
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}><Input aria-label="Ask the supplier agent" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Which of my invoices are unpaid?" className="flex-1" disabled={busy} /><Button type="submit" variant="primary" disabled={busy || !q.trim()} aria-label="Send"><Send size={14} /></Button></form>
        <Muted>Read-only. The agent cannot change bank details or payment dates.</Muted>
      </div>
    </Card>
  </div></div>;
}
