import { useState } from "react";
import { Link } from "react-router-dom";
import { HandCoins } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can, type StepUpStatus } from "../lib/perm";
import { decideBlock, drawBlock, drawTone, DRAW_STATUS, interestEstimate, money, pct, type BankExposure, type CreditDraw, type CreditOps, type CreditView } from "../lib/credit";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Stat, Table } from "../components/ui";
import { Section } from "../components/Shell";
import { SkeletonTable } from "../components/kit";
import { StepUpPrompt } from "../components/ApprovalCard";

/** Shown on every credit screen: there is no real lender behind this. */
export function LenderNote({ label, note }: { label: string; note: string }) {
  return <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]" data-testid="simulated-lender">
    <Badge v={label} tone="warn" className="mr-2" />{note.replace(`${label}. `, "")}</div>;
}
function Bar({ used, pending = 0, total }: { used: number; pending?: number; total: number }) {
  const u = pct(used, total); const p = Math.min(100 - u, pct(pending, total));
  return <div className="flex h-2 w-full overflow-hidden rounded-full bg-border" role="img" aria-label={`${u} percent drawn`}>
    <div className={u >= 90 ? "bg-bad" : u >= 70 ? "bg-warn" : "bg-primary"} style={{ width: `${u}%` }} /><div className="bg-warn/60" style={{ width: `${p}%` }} /></div>;
}
function StepUpIfNeeded({ error, threshold }: { error?: string; threshold: number }) {
  const { data: su } = useGet<StepUpStatus>("/auth/step-up", !!error && /step_up_required/.test(error));
  return error && /step_up_required/.test(error) && su ? <StepUpPrompt s={su} threshold={threshold} text={`Draws above ${money(threshold)} need a fresh code from your authenticator app. Enter it, then approve again.`} /> : null;
}

function DrawForm({ v }: { v: CreditView }) {
  const { run, busy, error } = useAct(); const [amount, setAmount] = useState("5000"); const [purpose, setPurpose] = useState("");
  const n = Number(amount); const block = drawBlock(n, v.line, v.usage); const big = n > v.stepUpThresholdUsd;
  return <Card title="Ask for a draw">
    <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
      <div className="flex flex-col gap-1"><Label>Amount ({v.line?.currency ?? "USD"})</Label><Input aria-label="Draw amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
      <div className="flex flex-col gap-1"><Label>What it is for</Label><Input aria-label="Draw purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Cover supplier payments in week 3" /></div>
    </div>
    <p className="mt-3 text-xs text-muted">A second person must approve every draw. {big ? `Over ${money(v.stepUpThresholdUsd)} the approver also needs an authenticator code. ` : ""}Nothing is booked until then.</p>
    {block && n > 0 && <p className="mt-1 text-xs text-bad" role="alert">{block}</p>}
    <div className="mt-3"><Button variant="primary" disabled={busy || !!block || purpose.trim().length < 3} onClick={async () => { const r = await run(() => api("/credit/draws", { amount: n, purpose })); if (r) setPurpose(""); }}>Ask for approval</Button></div>
    <ErrorNote msg={error} />
  </Card>;
}

function DrawRow({ d, v, meId, canApprove, canPay }: { d: CreditDraw; v: CreditView; meId?: string; canApprove: boolean; canPay: boolean }) {
  const { run, busy, error } = useAct(); const [amt, setAmt] = useState("");
  const block = decideBlock(d, meId, canApprove); const pay = Number(amt) || d.outstanding; const est = interestEstimate(pay, d.aprPct, d.fundedAt);
  const decide = (approve: boolean) => run(() => api(`/credit/draws/${d.id}/decide`, { approve }));
  return <tr className="border-t border-border align-top" data-testid={`draw-${d.id}`}>
    <td className="px-3 py-2"><div className="font-medium">{d.purpose}</div><Mono className="text-muted">{d.id}</Mono></td>
    <td className="px-3 py-2 tabular-nums text-[13px]">{money(d.amount, d.currency)}<div><Muted>{d.aprPct}% a year</Muted></div></td>
    <td className="px-3 py-2"><Badge v={DRAW_STATUS[d.status] ?? d.status} tone={drawTone(d.status)} />{d.status === "funded" && <div><Muted>{money(d.outstanding, d.currency)} still owed</Muted></div>}</td>
    <td className="px-3 py-2 text-[13px]">Asked by {d.requestedByName ?? d.requestedBy}{d.decidedByName && <div><Muted>{d.status === "rejected" ? "Rejected" : "Approved"} by {d.decidedByName}</Muted></div>}</td>
    <td className="px-3 py-2 text-[13px]">
      {d.status === "pending_approval" && (block ? <Muted>{block}</Muted> : <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => decide(true)}>Approve draw</Button><Button size="sm" disabled={busy} onClick={() => decide(false)}>Reject</Button>
        {d.needsStepUp && <Muted className="basis-full">Needs your authenticator code</Muted>}</div>)}
      {d.status === "funded" && (canPay ? <div className="flex flex-col gap-1"><div className="flex gap-2">
        <Input aria-label={`Repay amount for ${d.id}`} className="h-7 w-28" inputMode="decimal" placeholder={d.outstanding.toFixed(2)} value={amt} onChange={(e) => setAmt(e.target.value)} />
        <Button size="sm" disabled={busy || pay <= 0 || pay > d.outstanding} onClick={async () => { const r = await run(() => api(`/credit/draws/${d.id}/repay`, amt ? { amount: Number(amt) } : {})); if (r) setAmt(""); }}>Repay</Button></div>
        <Muted>About {money(est.interest, d.currency)} interest for {est.days} day{est.days === 1 ? "" : "s"}. A demo figure.</Muted></div> : <Muted>Your role cannot repay</Muted>)}
      {d.journalId && d.status !== "pending_approval" && <div><Link className="text-xs text-primary hover:underline" to="/app/ledger">See it in the entity ledger</Link></div>}
      <ErrorNote msg={error} /><StepUpIfNeeded error={error} threshold={v.stepUpThresholdUsd} />
    </td></tr>;
}

/** Client page: the line, what is drawn, and draws with maker-checker. */
export function CreditPage() {
  const { data: v, isLoading, error } = useGet<CreditView>("/credit"); const { data: me } = useMe();
  if (isLoading || !v) return <Section><PageHeader title="Credit line" sub="Working capital from your bank, inside the payment flow." />{error ? <ErrorNote msg={(error as Error).message} /> : <Card pad={false}><SkeletonTable rows={3} cols={5} /></Card>}</Section>;
  const cur = v.line?.currency ?? "USD";
  return <Section>
    <PageHeader title="Credit line" sub="Working capital from your bank, inside the payment flow. Your bank sets the limit and the rate." />
    <LenderNote label={v.lender} note={v.note} />
    {!v.line ? <EmptyState icon={HandCoins} title="No credit line yet" body="Your bank operator sets the limit and the rate. Ask your bank to set one up." /> : <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Limit" value={money(v.usage.limit, cur)} hint={`${v.line.aprPct}% a year, set by your bank`} />
        <Stat label="Drawn" value={money(v.usage.outstanding, cur)} hint={`${v.usage.usedPct}% of the limit in use`} />
        <Stat label="Waiting for approval" value={money(v.usage.pending, cur)} />
        <Stat label="Left to draw" value={money(v.usage.available, cur)} hint={v.line.status === "frozen" ? "The line is frozen by the bank" : undefined} />
      </div>
      <Bar used={v.usage.outstanding} pending={v.usage.pending} total={v.usage.limit} />
      {can(me, "flow.operate") && <DrawForm v={v} />}
      {!v.draws.length ? <EmptyState icon={HandCoins} title="No draws yet" body="Ask for a draw when the cash forecast shows a gap. A second person approves it." />
        : <Card title="Draws" pad={false}><div className="overflow-x-auto"><Table head={["Draw", "Amount", "Status", "People", "Next step"]}>{v.draws.map((d) => <DrawRow key={d.id} d={d} v={v} meId={me?.user.id} canApprove={can(me, "payments.approve")} canPay={can(me, "payments.pay")} />)}</Table></div></Card>}
      {!!v.repayments.length && <Card title="Repayments" pad={false}><div className="overflow-x-auto"><Table head={["Draw", "Principal", "Interest", "Days", "When"]}>{v.repayments.map((r) => <tr key={r.id} className="border-t border-border">
        <td className="px-3 py-2"><Mono>{r.drawId}</Mono></td><td className="px-3 py-2 tabular-nums text-[13px]">{money(r.principal, cur)}</td><td className="px-3 py-2 tabular-nums text-[13px]">{money(r.interest, cur)}</td>
        <td className="px-3 py-2 text-[13px]">{r.days}</td><td className="px-3 py-2 text-[13px]">{new Date(r.createdAt).toLocaleString()}</td></tr>)}</Table></div></Card>}
      <Muted>In the ledger a draw adds to {v.accounts.cash} and to {v.accounts.liability}. A repayment takes both down and books interest to {v.accounts.interest}.</Muted>
    </>}
  </Section>;
}

function CapCard({ b }: { b: BankExposure }) {
  const { run, busy, error } = useAct(); const [cap, setCap] = useState(String(b.cap));
  return <Card title={`${b.name} exposure`}>
    <Bar used={b.outstanding} pending={b.pending} total={b.cap} />
    <div className="mt-2 text-[13px]">{money(b.outstanding)} owed of a {money(b.cap)} cap. {money(b.headroom)} left to lend. {money(b.pending)} waits for approval. {money(b.committed)} in limits across {b.lines} line{b.lines === 1 ? "" : "s"}.</div>
    <div className="mt-3 flex items-end gap-2"><div className="flex flex-col gap-1"><Label>Exposure cap (USD)</Label><Input aria-label={`Exposure cap for ${b.name}`} className="w-40" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></div>
      <Button size="sm" disabled={busy || !(Number(cap) >= 0) || Number(cap) === b.cap} onClick={() => run(() => api(`/ops/credit/caps/${b.bankId}`, { cap: Number(cap) }, { method: "PUT" }))}>Save cap</Button></div>
    <ErrorNote msg={error} />
  </Card>;
}
function LineRow({ c, canSet }: { c: CreditOps["clients"][number]; canSet: boolean }) {
  const { run, busy, error } = useAct();
  const [f, setF] = useState({ limit: String(c.line?.limit ?? 25000), aprPct: String(c.line?.aprPct ?? 9.5), status: c.line?.status ?? "active" });
  const cur = c.line?.currency ?? "USD";
  return <tr className="border-t border-border align-top">
    <td className="px-3 py-2"><div className="font-medium">{c.name}</div><Mono className="text-muted">{c.tenantId}</Mono></td>
    <td className="px-3 py-2 text-[13px]">{c.line ? <><Bar used={c.outstanding} pending={c.pending} total={c.limit} /><div className="mt-1 tabular-nums">{money(c.outstanding, cur)} drawn of {money(c.limit, cur)}</div><Muted>{money(c.pending, cur)} waits for approval</Muted></> : <Muted>No line yet</Muted>}</td>
    <td className="px-3 py-2">{c.line ? <Badge v={c.line.status === "active" ? "Active" : "Frozen"} tone={c.line.status === "active" ? "ok" : "warn"} /> : <Badge v="Not set" tone="neutral" />}</td>
    <td className="px-3 py-2">{canSet ? <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1"><Label>Limit</Label><Input aria-label={`Limit for ${c.name}`} className="h-7 w-28" inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></div>
      <div className="flex flex-col gap-1"><Label>Rate % a year</Label><Input aria-label={`Rate for ${c.name}`} className="h-7 w-20" inputMode="decimal" value={f.aprPct} onChange={(e) => setF({ ...f, aprPct: e.target.value })} /></div>
      <div className="flex flex-col gap-1"><Label>State</Label><Select aria-label={`State for ${c.name}`} className="h-7" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as "active" | "frozen" })}><option value="active">Active</option><option value="frozen">Frozen</option></Select></div>
      <Button size="sm" disabled={busy || !(Number(f.limit) >= 0) || !(Number(f.aprPct) >= 0)} onClick={() => run(() => api(`/ops/credit/lines/${c.tenantId}`, { limit: Number(f.limit), aprPct: Number(f.aprPct), status: f.status }, { method: "PUT" }))}>{c.line ? "Save line" : "Set up line"}</Button>
    </div> : <Muted>Your role cannot change lines</Muted>}<ErrorNote msg={error} /></td></tr>;
}
/** Operator page: set each client's limit and rate, and the bank's exposure cap. */
export function OperatorCredit() {
  const { data: v, isLoading, error } = useGet<CreditOps>("/ops/credit"); const { data: me } = useMe();
  return <Section>
    <PageHeader title="Credit lines" sub="Set a limit and a rate for each business client, and a cap on what the bank lends in total." />
    {v && <LenderNote label={v.lender} note={v.note} />}
    {error ? <ErrorNote msg={(error as Error).message} /> : isLoading || !v ? <Card pad={false}><SkeletonTable rows={3} cols={4} /></Card> : <>
      <div className="grid gap-3 lg:grid-cols-2">{v.banks.map((b) => <CapCard key={`${b.bankId}-${b.cap}`} b={b} />)}</div>
      <Card title="Client lines" pad={false}><div className="overflow-x-auto"><Table head={["Client", "Usage", "State", "Limit and rate"]}>{v.clients.map((c) => <LineRow key={`${c.tenantId}-${c.line?.updatedAt ?? ""}`} c={c} canSet={can(me, "treasury.sweep")} />)}</Table></div></Card>
      <Muted>Clients ask for draws on their Credit line page. A second person at the client approves each one. Draws over {money(v.stepUpThresholdUsd)} also need an authenticator code.</Muted>
    </>}
  </Section>;
}
