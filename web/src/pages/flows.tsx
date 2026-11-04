import { useState } from "react";
import { Ban, Play, ShieldAlert, Sparkles } from "lucide-react";
import { api, useAppState, useGet, useMe, useAct } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Json, Label, Mono, Muted, Select, Table, Textarea } from "../components/ui";

const EMPTY = { pos: [], invoices: [], intents: [], settlements: [], refunds: [], receipts: [], agents: [], mandates: [], suppliers: [], payeeChanges: [], alerts: [], erp: [], evidence: [], journals: [], signers: [], killSwitch: false };
/** Domain data belongs to the Acme demo tenant. Other client tenants start empty. */
export function useScopedState() {
  const { data: me } = useMe(); const q = useAppState();
  const empty = !!me && me.tenant.kind === "client" && me.tenant.id !== "tnt-acme";
  return { st: q.data ? (empty ? { ...q.data, ...EMPTY } : q.data) : null, loading: q.isLoading, error: q.error as Error | null, empty };
}
export function Loading({ error }: { error?: Error | null }) {
  return error ? <ErrorNote msg={`Could not reach the BFF. ${error.message}`} /> : <div className="py-10 text-center text-xs text-muted">Loading</div>;
}
export const Busy = ({ on }: { on: boolean }) => on ? <Muted>Working. Live LLM calls can take up to 60 seconds.</Muted> : null;

export function FlowTracker({ st, poId }: { st: any; poId?: string }) {
  const po = st.pos.find((x: any) => x.id === poId);
  if (!po) return <Muted>No purchase order yet. Draft one below or run a scenario.</Muted>;
  const inv = st.invoices.find((i: any) => i.poId === po.id);
  const pi = inv && st.intents.find((i: any) => i.invoiceId === inv.id);
  const settled = pi?.status === "settled";
  const steps: [string, "done" | "fail" | ""][] = [
    ["Need", "done"], ["PO draft", "done"], ["Policy", po.policy.outcome === "deny" ? "fail" : "done"],
    ["Approval", po.status === "rejected" ? "fail" : po.status === "pending_approval" ? "" : "done"],
    ["Goods receipt", st.receipts.some((g: any) => g.poId === po.id) ? "done" : ""], ["Invoice", inv ? "done" : ""],
    ["3-way match", inv?.matchStatus === "matched" ? "done" : inv?.matchStatus === "exception" ? "fail" : ""],
    ["Rail", pi?.route?.rail ? "done" : pi ? "fail" : ""], ["Compliance", pi?.compliance ? (pi.compliance.outcome === "clear" ? "done" : "fail") : ""],
    ["Settlement", settled ? "done" : pi?.status === "blocked" ? "fail" : ""], ["Ledger", settled ? "done" : ""], ["ERP sync", settled ? "done" : ""],
  ];
  return <div className="flex flex-wrap gap-1.5">{steps.map(([n, s]) => <span key={n} className={s === "done" ? "rounded-full bg-ok/10 px-2.5 py-1 text-[11px] font-medium text-ok" : s === "fail" ? "rounded-full bg-bad/10 px-2.5 py-1 text-[11px] font-medium text-bad" : "rounded-full bg-subtle px-2.5 py-1 text-[11px] text-muted"}>{n}</span>)}</div>;
}

export function Scenarios({ onRun }: { onRun?: (r: any) => void }) {
  const { run, busy, error } = useAct(); const [flow, setFlow] = useState<any>(null);
  const go = async (scenario: string, need: string) => { const r = await run(() => api("/scenario/run", { need, scenario })); if (r) { setFlow(r); onRun?.(r); } };
  return <Card title="Scenarios" action={<Busy on={busy} />}>
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy} onClick={() => go("happy", "Need 2000 sealed 6204 bearings for line 3 maintenance")}><Play size={14} />Happy path to USDC</Button>
      <Button variant="danger" disabled={busy} onClick={() => go("sanctioned", "Order 2 tons of 304 stainless sheet")}><Ban size={14} />Sanctioned wallet</Button>
      <Button disabled={busy} onClick={() => go("poisoned", "Need 2000 sealed 6204 bearings for line 3 maintenance")}><ShieldAlert size={14} />Poisoned invoice</Button>
    </div>
    <ErrorNote msg={error} />
    {flow && <Table className="mt-3">{flow.steps.map((s: any, i: number) => <tr key={i}><td><Badge v={s.ok ? "pass" : "fail"} /></td><td className="whitespace-nowrap">{s.step}</td><td className="break-all"><Mono className="text-muted">{JSON.stringify(s.detail).slice(0, 240)}</Mono></td></tr>)}</Table>}
  </Card>;
}

export function BuyerDraft({ onPo }: { onPo?: (id: string) => void }) {
  const [need, setNeed] = useState("We need 2000 sealed 6204 ball bearings for the line 3 maintenance window next week");
  const [draft, setDraft] = useState<any>(null); const [po, setPo] = useState<any>(null);
  const { run, busy, error } = useAct();
  return <div className="grid gap-4 lg:grid-cols-2">
    <Card title={<span className="inline-flex items-center gap-1.5"><Sparkles size={14} className="text-primary" />Buyer agent drafts a PO</span>} action={<Busy on={busy} />}>
      <Textarea className="font-sans text-[13px]" value={need} onChange={(e) => setNeed(e.target.value)} />
      <div className="mt-2 flex gap-2">
        <Button variant="primary" disabled={busy} onClick={async () => { const r: any = await run(() => api("/buyer/draft", { need })); if (r) { setDraft(r); setPo(null); } }}>Draft PO</Button>
        <Button disabled={busy || !draft} onClick={async () => { const r: any = await run(() => api("/purchase-orders", { draft: draft.value })); if (r) { setPo(r); onPo?.(r.id); } }}>Submit to policy engine</Button>
      </div>
      <ErrorNote msg={error} />
      {draft && <div className="mt-3">
        <div className="mb-2 flex items-center gap-2"><Badge v={draft.source} tone="primary" /><Muted>{draft.note}</Muted></div>
        <Table head={["SKU", "Item", "Qty", "Unit", "Line"]}>{draft.value.lines.map((l: any) => <tr key={l.sku}><td><Mono>{l.sku}</Mono></td><td>{l.description}</td><td>{l.qty}</td><td>{usd(l.unitPrice)}</td><td>{usd(l.qty * l.unitPrice)}</td></tr>)}</Table>
        <Muted>Supplier {draft.value.supplierId}, category {draft.value.category}. Prices come from the catalog. The model cannot set them.</Muted>
      </div>}
    </Card>
    <Card title="Policy check">
      {po ? <>
        <div className="mb-2 flex flex-wrap items-center gap-2"><Mono>{po.id}</Mono><span className="font-semibold">{usd(po.total)}</span><Badge v={po.policy.outcome} /><Badge v={po.status} />{po.erpRef && <Muted>ERP ref {po.erpRef}</Muted>}</div>
        <Table>{po.policy.checks.map((c: any) => <tr key={c.rule}><td><Badge v={c.pass ? "pass" : "fail"} /></td><td>{c.rule}</td><td><Muted>{c.detail}</Muted></td></tr>)}</Table>
      </> : <EmptyState title="No draft submitted" body="Submit a draft to see every rule the engine checked." />}
    </Card>
  </div>;
}

export function PoTable({ st }: { st: any }) {
  const { run, busy, error } = useAct();
  return <Card title="Purchase orders" pad={false}>
    <ErrorNote msg={error} />
    {st.pos.length ? <Table head={["PO", "Supplier", "Category", "Total", "Policy", "Status", ""]}>{[...st.pos].reverse().map((p: any) => <tr key={p.id}>
      <td><Mono>{p.id}</Mono></td><td>{p.supplierId}</td><td>{p.category}</td><td className="tabular-nums">{usd(p.total)}</td><td><Badge v={p.policy.outcome} /></td><td><Badge v={p.status} /></td>
      <td className="text-right">{p.status === "approved" && <Button size="sm" disabled={busy} onClick={() => run(() => api("/goods-receipts", { poId: p.id }))}>Post goods receipt</Button>}</td></tr>)}</Table>
      : <EmptyState title="No purchase orders" body="The buyer agent drafts POs from a plain language need." />}
  </Card>;
}

export function ApprovalInbox({ st }: { st: any }) {
  const pending = st.pos.filter((x: any) => x.status === "pending_approval");
  const { run, busy, error } = useAct();
  return <Card title={`Approvals inbox (${pending.length})`} pad={false}>
    <ErrorNote msg={error} />
    {!pending.length ? <EmptyState title="Inbox zero" body="Nothing waits for you. A need above 10,000 USD, for example 30 servo motors, lands here." /> :
      <ul className="divide-y divide-border">{pending.map((p: any) => <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1"><div className="font-medium">{p.supplierId} <span className="tabular-nums">{usd(p.total)}</span></div><Muted>{p.id} . {p.policy.reasons.join(", ")}</Muted></div>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => run(() => api(`/approvals/${p.id}`, { approve: true }))}>Approve</Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => api(`/approvals/${p.id}`, { approve: false }))}>Reject</Button></li>)}</ul>}
  </Card>;
}

export function PayeeChanges({ st }: { st: any }) {
  const [f, setF] = useState({ supplierId: "sup-northwind", field: "walletAddress", newValue: "0x7777000000000000000000000000000000007777", requestedBy: "usr-clerk-pat" });
  const { run, busy, error } = useAct();
  return <Card title="Payee detail changes">
    <Muted>Bank and wallet details only change from the ERP vendor master. Each change needs two approvers other than the requester and a phone callback.</Muted>
    <div className="mt-3 flex flex-wrap gap-2">
      <Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>{st.suppliers.map((s: any) => <option key={s.id}>{s.id}</option>)}</Select>
      <Select value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option>walletAddress</option><option>bankDetailsRef</option></Select>
      <Input className="min-w-60 flex-1" value={f.newValue} onChange={(e) => setF({ ...f, newValue: e.target.value })} />
      <Button variant="primary" disabled={busy || !st.suppliers.length} onClick={() => run(() => api("/erp/vendor-master/changes", { ...f, source: "erp" }))}>Request via ERP</Button>
    </div>
    <ErrorNote msg={error} />
    {!!st.payeeChanges.length && <Table className="mt-3">{st.payeeChanges.map((c: any) => <tr key={c.id}><td><Mono>{c.id}</Mono></td><td>{c.supplierId} {c.field}</td><td><Mono>{c.newValue}</Mono></td><td>{c.approvals.length} of 2</td><td>callback <Badge v={String(c.callbackVerified)} /></td><td><Badge v={c.status} /></td>
      <td className="flex gap-1">{c.status === "pending" && <>
        <Button size="sm" disabled={busy} onClick={() => run(() => api(`/erp/vendor-master/changes/${c.id}/approve`, { approver: "usr-controller-sam" }))}>Approve as Sam</Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => api(`/erp/vendor-master/changes/${c.id}/approve`, { approver: "usr-treasurer-lee" }))}>Approve as Lee</Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => api(`/erp/vendor-master/changes/${c.id}/callback`, { confirmed: true }))}>Callback done</Button></>}</td></tr>)}</Table>}
  </Card>;
}

export function InvoiceDesk({ st }: { st: any }) {
  const open = st.pos.filter((p: any) => ["approved", "received"].includes(p.status));
  const [poId, setPoId] = useState(""); const [text, setText] = useState(""); const [bump, setBump] = useState(0);
  const { run, busy, error } = useAct(); const sel = poId || open[0]?.id || "";
  return <Card title="Supplier agent sends an invoice" action={<Busy on={busy} />}>
    {!open.length ? <EmptyState title="No approved purchase orders" body="Approve a PO first. The supplier agent then posts goods receipt and invoices it." /> : <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={sel} onChange={(e) => setPoId(e.target.value)}>{open.map((p: any) => <option key={p.id} value={p.id}>{p.id} {p.supplierId} {usd(p.total)} {p.status}</option>)}</Select>
        <Button disabled={busy || st.pos.find((p: any) => p.id === sel)?.status !== "approved"} onClick={() => run(() => api("/goods-receipts", { poId: sel }))}>Post goods receipt</Button>
        <Label>Price variance percent</Label><Input className="w-20" type="number" value={bump} onChange={(e) => setBump(Number(e.target.value))} />
        <Button disabled={busy} onClick={async () => { const r: any = await run(() => api("/invoices/render", { poId: sel, priceBumpPct: bump })); if (r) setText(r.text); }}>Generate invoice</Button>
        <Button disabled={busy} onClick={async () => { const r: any = await run(() => api("/invoices/render", { poId: sel, poison: true })); if (r) setText(r.text); }}>Generate poisoned invoice</Button>
      </div>
      <Textarea className="mt-2 min-h-40" value={text} onChange={(e) => setText(e.target.value)} placeholder="Invoice text appears here" />
      <Button className="mt-2" variant="primary" disabled={busy || !text} onClick={() => run(() => api("/invoices", { poId: sel, text }))}>Submit invoice for the model to read</Button>
    </>}
    <ErrorNote msg={error} />
  </Card>;
}

export function InvoiceTable({ st }: { st: any }) {
  const { run, busy, error } = useAct();
  const last = st.invoices.filter((i: any) => i.match).slice(-1)[0];
  return <>
    <Card title="Invoices and 3-way match" pad={false}>
      <ErrorNote msg={error} />
      {st.invoices.length ? <Table head={["Invoice", "PO", "Amount", "Read by", "Injection", "Match", ""]}>{st.invoices.map((i: any) => <tr key={i.id}>
        <td>{i.number}<div><Mono className="text-muted">{i.id}</Mono></div></td><td><Mono>{i.poId}</Mono></td><td className="tabular-nums">{usd(i.amount)}</td><td><Muted>{i.extractedBy}</Muted></td>
        <td>{i.injection?.length ? <Badge v="ignored" tone="warn" /> : <Muted>none</Muted>}</td><td><Badge v={i.matchStatus} /></td>
        <td className="text-right">{i.matchStatus === "unmatched" && <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api(`/invoices/${i.id}/match`, {}))}>Run 3-way match</Button>}</td></tr>)}</Table>
        : <EmptyState title="No invoices" body="Invoices from supplier agents show here once submitted." />}
    </Card>
    {last && <Card title={`Last match ${last.number}`}>
      <Muted>PO {usd(last.match.totals.po)}, invoice {usd(last.match.totals.invoice)}, variance {last.match.totals.variancePct} percent, tolerance {last.match.tolerancePct} percent</Muted>
      <Table className="mt-2" head={["SKU", "PO qty", "Received", "Invoiced", "PO price", "Invoice price", "Result"]}>{last.match.lines.map((l: any) => <tr key={l.sku}><td><Mono>{l.sku}</Mono></td><td>{l.poQty}</td><td>{l.grQty}</td><td>{l.invQty}</td><td>{usd(l.poPrice)}</td><td>{usd(l.invPrice)}</td><td><Badge v={l.ok ? "pass" : "fail"} /> <Muted>{l.note}</Muted></td></tr>)}</Table>
    </Card>}
  </>;
}

export function AgentRegistry({ st }: { st: any }) {
  const { run, busy, error } = useAct();
  return <Card title="Agent registry" pad={false} action={<Button size="sm" variant={st.killSwitch ? "outline" : "danger"} disabled={busy} onClick={() => run(() => api("/kill-switch", { on: !st.killSwitch }))}>{st.killSwitch ? "Release kill switch" : "Kill switch"}</Button>}>
    <ErrorNote msg={error} />
    {st.killSwitch && <div className="border-b border-border bg-bad/10 px-4 py-2 text-xs font-medium text-bad">Kill switch is on. No agent can move money.</div>}
    {st.agents.length ? <Table head={["Agent", "Org", "Role", "KYA", "Status", ""]}>{st.agents.map((a: any) => <tr key={a.id}><td>{a.name}<div><Mono className="text-muted">{a.id}</Mono></div></td><td>{a.orgId}</td><td>{a.erpRole}</td><td><Badge v={a.kyaStatus} /></td><td><Badge v={a.status} /></td>
      <td className="text-right"><Button size="sm" disabled={busy} onClick={() => run(() => api(`/agents/${a.id}/${a.status === "active" ? "suspend" : "resume"}`, {}))}>{a.status === "active" ? "Suspend" : "Resume"}</Button></td></tr>)}</Table>
      : <EmptyState title="No agents registered" body="Agents with a signed mandate show here." />}
  </Card>;
}
export function Mandates({ st }: { st: any }) {
  return <Card title="Mandates">{st.mandates.length ? <div className="grid gap-3 md:grid-cols-2">{st.mandates.map((m: any) => <div key={m.id} className="rounded-lg border border-border p-3">
    <div className="flex items-center gap-2"><Mono>{m.id}</Mono><Muted>signed by {m.principalUserId}</Muted></div>
    <dl className="mt-2 grid grid-cols-2 gap-1 text-xs"><dt className="text-muted">Per transaction</dt><dd>{usd(m.perTxnMax)}</dd><dt className="text-muted">Total</dt><dd>{usd(m.maxAmount)}</dd><dt className="text-muted">Human approval above</dt><dd>{usd(m.approvalThreshold)}</dd><dt className="text-muted">Categories</dt><dd>{m.allowedCategories.join(", ")}</dd><dt className="text-muted">Rails</dt><dd>{m.allowedRails.join(", ")}</dd></dl>
  </div>)}</div> : <EmptyState title="No mandates" />}</Card>;
}
export function McpTools() {
  const { data } = useGet<{ tools: any[] }>("/mcp/tools");
  return <Card title="Agent gateway tools (MCP)" pad={false}><Table>{(data?.tools ?? []).map((x) => <tr key={x.name}><td><Mono>{x.name}</Mono></td><td><Muted>{x.description}</Muted></td></tr>)}</Table></Card>;
}
export function SupplierTable({ st }: { st: any }) {
  return <Card title="Suppliers" pad={false}>{st.suppliers.length ? <Table head={["Supplier", "ERP", "Preferred rail", "Accepted", "Screening", "Wallet"]}>{st.suppliers.map((s: any) => <tr key={s.id}><td>{s.name}<div><Mono className="text-muted">{s.id}</Mono></div></td><td>{s.erp}</td><td>{s.preferredRail}</td><td>{s.acceptedRails.join(", ")}</td><td><Badge v={s.screeningStatus} /></td><td><Mono>{s.walletAddress ?? "none"}</Mono></td></tr>)}</Table>
    : <EmptyState title="No suppliers yet" body="Suppliers join through the onboarding link. That portal arrives in a later step." />}</Card>;
}

export function PaymentDesk({ st }: { st: any }) {
  const payable = st.invoices.filter((i: any) => i.matchStatus === "matched" && !i.paid);
  const [urgency, setUrgency] = useState("standard");
  const [signers, setSigners] = useState<string[]>(["signer-treasury-ops", "signer-policy-engine"]);
  const { run, busy, error } = useAct();
  const pi = [...st.intents].reverse()[0];
  return <>
    <Card title="Ready to pay" action={<Busy on={busy} />}>
      <div className="flex flex-wrap items-center gap-3"><Label>Urgency</Label><Select value={urgency} onChange={(e) => setUrgency(e.target.value)}><option>standard</option><option>urgent</option></Select>
        <Label>MPC signers, quorum 2 of 3</Label>{st.signers.map((s: any) => <label key={s.id} className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={signers.includes(s.id)} onChange={(e) => setSigners(e.target.checked ? [...signers, s.id] : signers.filter((x) => x !== s.id))} />{s.role}</label>)}</div>
      <ErrorNote msg={error} />
      {payable.length ? <Table className="mt-2">{payable.map((i: any) => <tr key={i.id}><td>{i.number}</td><td>{i.supplierId}</td><td className="tabular-nums">{usd(i.amount)}</td>
        <td className="text-right"><Button variant="primary" size="sm" disabled={busy} onClick={() => run(() => api(`/invoices/${i.id}/pay`, { urgency, approvers: signers }, { headers: { "Idempotency-Key": `ui-${i.id}-${Date.now()}` } }))}>Route, screen and pay</Button></td></tr>)}</Table>
        : <EmptyState title="Nothing to pay" body="Matched invoices that are not paid show here." />}
    </Card>
    {pi && <div className="grid gap-4 lg:grid-cols-2">
      <Card title={`Rail choice for ${pi.id}`}>
        <div className="mb-2 flex items-center gap-2">Status <Badge v={pi.status} />{pi.route?.rail && <>Rail <b>{pi.route.rail.toUpperCase()}</b></>}</div>
        <p className="mb-2 text-xs"><Badge v={pi.explainedBy === "llm" ? "Model explanation" : "Template explanation"} tone="neutral" /> {pi.explanation}</p>
        <Table head={["Rail", "Eligible", "Fee", "Score", "Why"]}>{pi.route?.options.map((o: any) => <tr key={o.rail}><td>{o.rail.toUpperCase()}</td><td><Badge v={String(o.eligible)} /></td><td>{usd(o.feeUsd)}</td><td>{o.score}</td><td><Muted>{o.why.join(", ")}</Muted></td></tr>)}</Table>
        {pi.blockedReason && <ErrorNote msg={pi.blockedReason} />}
      </Card>
      <Card title="Compliance, Travel Rule and custody">
        <Table>{pi.compliance?.checks.map((c: any) => <tr key={c.kind}><td>{c.kind}</td><td><Badge v={c.result} /></td><td><Muted>{c.detail}</Muted></td><td><Mono className="text-muted">{c.providerRef}</Mono></td></tr>)}</Table>
        {pi.compliance?.travelRule && <details className="mt-2"><summary className="cursor-pointer text-xs text-muted">Travel Rule record (IVMS101)</summary><Json v={pi.compliance.travelRule} /></details>}
        {pi.custody && <p className="mt-2 text-xs">MPC custody <Badge v={pi.custody.approved ? "approved" : "blocked"} /> {pi.custody.shares.length} of {pi.custody.quorum} signers</p>}
      </Card>
    </div>}
    <Settlements st={st} />
  </>;
}
export function Settlements({ st }: { st: any }) {
  const [amt, setAmt] = useState(100); const { run, busy, error } = useAct();
  return <Card title="Settlements and refunds" pad={false} action={<><Label>Refund amount</Label><Input className="h-7 w-24" type="number" value={amt} onChange={(e) => setAmt(Number(e.target.value))} /></>}>
    <ErrorNote msg={error} />
    {st.settlements.length ? <Table head={["Settlement", "Rail", "Amount", "Reference", ""]}>{st.settlements.map((s: any) => <tr key={s.id}><td><Mono>{s.id}</Mono></td><td>{s.rail.toUpperCase()}</td><td className="tabular-nums">{usd(st.intents.find((i: any) => i.id === s.paymentIntentId)?.amount)}</td><td><Mono>{s.txHash ?? s.railRef}</Mono></td>
      <td className="text-right"><Button size="sm" disabled={busy} onClick={() => run(() => api("/refunds", { paymentIntentId: s.paymentIntentId, amount: amt, reason: "Damaged goods credit" }))}>Refund {usd(amt)}</Button></td></tr>)}</Table>
      : <EmptyState title="No settlements yet" />}
    {!!st.refunds.length && <Table head={["Refund", "For", "Amount", "Status", "Reference"]}>{st.refunds.map((r: any) => <tr key={r.id}><td><Mono>{r.id}</Mono></td><td><Mono>{r.originalIntentId}</Mono></td><td>{usd(r.amount)}</td><td><Badge v={r.status} /></td><td><Mono>{r.txHash ?? r.railRef}</Mono></td></tr>)}</Table>}
    <p className="px-4 py-2 text-xs text-muted">Stablecoin sends are final. A refund is a new forward payment.</p>
  </Card>;
}

export function Ledger() {
  const { data: l } = useGet<any>("/ledger/journals");
  if (!l) return <Loading />;
  return <div className="grid gap-4 lg:grid-cols-2">
    <Card title="Trial balance" action={<Badge v={l.trialBalance.balanced ? "balanced" : "unbalanced"} />}>
      <Muted>Debits {usd(l.trialBalance.totalDebit)}, credits {usd(l.trialBalance.totalCredit)}</Muted>
      {Object.keys(l.trialBalance.accounts).length ? <Table className="mt-2" head={["Account", "Debit", "Credit", "Balance"]}>{Object.entries(l.trialBalance.accounts).map(([k, v]: any) => <tr key={k}><td>{k}</td><td>{usd(v.debit)}</td><td>{usd(v.credit)}</td><td className="font-semibold">{usd(v.balance)}</td></tr>)}</Table> : <EmptyState title="No postings yet" />}
    </Card>
    <Card title="Journal entries" pad={false}>
      {l.journals.length ? <Table head={["Journal", "Account", "Debit", "Credit"]}>{[...l.journals].reverse().flatMap((j: any) => j.entries.map((e: any, k: number) => <tr key={e.id}><td>{k === 0 ? <><Mono>{j.id}</Mono><div><Muted>{j.memo}</Muted></div></> : ""}</td><td>{e.account}</td><td>{e.debit ? usd(e.debit) : ""}</td><td>{e.credit ? usd(e.credit) : ""}</td></tr>))}</Table> : <EmptyState title="No journals yet" />}
    </Card>
  </div>;
}
export function Reconciliation() {
  const { data: l } = useGet<any>("/ledger/journals"); const [camt, setCamt] = useState("");
  return <Card title="Settlement to ledger match" action={<><Button size="sm" onClick={async () => setCamt(await api("/statements/camt053"))}>Export camt.053</Button><Button size="sm" variant="ghost" asChild><a href="/api/statements/camt053" target="_blank" rel="noreferrer">Open XML</a></Button></>}>
    {l?.reconciliation.length ? <Table head={["Settlement", "Journal", "Result"]}>{l.reconciliation.map((r: any) => <tr key={r.settlementId}><td><Mono>{r.settlementId}</Mono></td><td><Mono>{r.journalId}</Mono></td><td><Badge v={r.matched ? "matched" : "exception"} /></td></tr>)}</Table> : <EmptyState title="Nothing to reconcile" body="Settled payments are matched to ledger journals here." />}
    {camt && <pre className="mt-3">{camt}</pre>}
  </Card>;
}
export function EvidenceLog() {
  const { data: v } = useGet<any>("/evidence"); const [q, setQ] = useState("");
  if (!v) return <Loading />;
  const rows = v.records.filter((r: any) => !q || r.subjectId.includes(q) || r.event.includes(q));
  return <Card title="Evidence and audit log" pad={false} action={<><Badge v={v.verification.valid ? "chain verified" : `broken at ${v.verification.brokenAt}`} /><Muted>{v.records.length} records</Muted>
    <Input className="h-7 w-56" placeholder="Filter by subject or event" value={q} onChange={(e) => setQ(e.target.value)} />
    <Button size="sm" variant="ghost" asChild><a href={`data:application/json,${encodeURIComponent(JSON.stringify(rows, null, 2))}`} download="evidence-export.json">Export JSON</a></Button></>}>
    <Table head={["#", "Subject", "Event", "Hash", "Prev", "Payload"]}>{[...rows].reverse().slice(0, 300).map((r: any) => <tr key={r.id}><td className="tabular-nums">{r.seq}</td><td><Mono>{r.subjectType} {r.subjectId}</Mono></td><td>{r.event}</td><td><Mono>{r.hash.slice(0, 12)}</Mono></td><td><Mono className="text-muted">{r.prevHash.slice(0, 12)}</Mono></td><td><details><summary className="cursor-pointer text-xs text-muted">view</summary><Json v={r.payload} /></details></td></tr>)}</Table>
  </Card>;
}
export function Alerts({ st }: { st: any }) {
  return <Card title="Alerts" pad={false}>{st.alerts.length ? <Table>{[...st.alerts].reverse().slice(0, 15).map((a: any, i: number) => <tr key={i}><td><Badge v={a.kind} /></td><td>{a.detail}</td><td><Muted>{a.at.slice(11, 19)}</Muted></td></tr>)}</Table> : <EmptyState title="No alerts" />}</Card>;
}
export function ErpFeed({ st }: { st: any }) {
  return <Card title="ERP sync" pad={false}>{st.erp.length ? <Table>{[...st.erp].reverse().slice(0, 12).map((e: any) => <tr key={e.id}><td>{e.system}</td><td><Mono>{e.kind}</Mono></td><td><details><summary className="cursor-pointer text-xs text-muted">payload</summary><Json v={e.payload} /></details></td></tr>)}</Table> : <EmptyState title="No ERP events yet" />}</Card>;
}
