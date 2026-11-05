import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CreditCard, Plus } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can, type StepUpStatus } from "../lib/perm";
import { actionsFor, masked, money, STATUS_TEXT, statusTone, TYPES, usedPct, type CardAuth, type CardView } from "../lib/cards";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Table } from "../components/ui";
import { Section } from "../components/Shell";
import { SkeletonTable } from "../components/kit";
import { StepUpPrompt } from "../components/ApprovalCard";

type ListResp = { cards: CardView[]; issuer: { kind: string; label: string; reason: string }; stepUpThresholdUsd: number };

function IssuerNote({ i }: { i: ListResp["issuer"] }) {
  return <div className={`rounded-md border px-3 py-2 text-[13px] ${i.kind === "stripe" ? "border-ok/30 bg-ok/10" : "border-warn/40 bg-warn/10"}`} data-testid="issuer">
    <span className="font-semibold">{i.label}.</span> {i.reason}. Test mode only, no real money moves.</div>;
}

function LimitBar({ c }: { c: CardView }) {
  const p = usedPct(c);
  return <div><div className="h-2 w-full overflow-hidden rounded-full bg-border"><div className={`h-full ${p >= 90 ? "bg-bad" : p >= 70 ? "bg-warn" : "bg-primary"}`} style={{ width: `${p}%` }} /></div>
    <div className="mt-1 text-xs text-muted">{money(c.spent, c.currency)} of {money(c.limit, c.currency)} used {c.period === "month" ? "this month" : "on this card"}. {money(c.remaining, c.currency)} left.</div></div>;
}

function StepUpIfNeeded({ error, threshold }: { error?: string; threshold: number }) {
  const { data: su } = useGet<StepUpStatus>("/auth/step-up", !!error && /step_up_required/.test(error));
  return error && /step_up_required/.test(error) && su ? <StepUpPrompt s={su} threshold={threshold} /> : null;
}

function IssueForm({ threshold, onDone }: { threshold: number; onDone: (id: string) => void }) {
  const { run, busy, error } = useAct();
  const { data: agents } = useGet<any[]>("/workspace/agents"); const { data: sups } = useGet<any[]>("/workspace/suppliers");
  const [f, setF] = useState({ type: "one_time", label: "", limit: "500", currency: "USD", expiryMonths: "12", supplierId: "", merchant: "", mcc: "", poId: "", agentId: "" });
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const big = Number(f.limit) > threshold;
  const submit = async () => {
    const body: any = { type: f.type, label: f.label, limit: Number(f.limit), currency: f.currency, expiryMonths: Number(f.expiryMonths) };
    for (const k of ["supplierId", "merchant", "mcc", "poId", "agentId"] as const) if (f[k]) body[k] = f[k];
    const r = await run(() => api<{ card: CardView; needsApproval: boolean }>("/cards", body)); if (r) onDone(r.card.id);
  };
  return <Card title="Issue a card">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-1"><Label>Card type</Label><Select value={f.type} onChange={set("type")}>{TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</Select><Muted>{TYPES.find((t) => t.v === f.type)?.hint}</Muted></div>
      <div className="flex flex-col gap-1"><Label>Name</Label><Input value={f.label} onChange={set("label")} placeholder="Line 3 spares" /></div>
      <div className="flex flex-col gap-1"><Label>{f.type === "recurring" || f.type === "agent" ? "Monthly limit" : "Limit"}</Label><Input inputMode="decimal" value={f.limit} onChange={set("limit")} /></div>
      <div className="flex flex-col gap-1"><Label>Currency</Label><Select value={f.currency} onChange={set("currency")}>{["USD", "EUR", "GBP"].map((c) => <option key={c}>{c}</option>)}</Select></div>
      <div className="flex flex-col gap-1"><Label>Expires in (months)</Label><Input inputMode="numeric" value={f.expiryMonths} onChange={set("expiryMonths")} /></div>
      {f.type === "agent" && <div className="flex flex-col gap-1"><Label>Agent</Label><Select value={f.agentId} onChange={set("agentId")}><option value="">Pick an agent</option>{(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></div>}
      <div className="flex flex-col gap-1"><Label>Supplier (optional)</Label><Select value={f.supplierId} onChange={set("supplierId")}><option value="">Any allowed</option>{(sups ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></div>
      {f.type !== "agent" && <div className="flex flex-col gap-1"><Label>Merchant name (optional)</Label><Input value={f.merchant} onChange={set("merchant")} /></div>}
      {f.type !== "agent" && <div className="flex flex-col gap-1"><Label>MCC (optional)</Label><Input inputMode="numeric" maxLength={4} value={f.mcc} onChange={set("mcc")} placeholder="5085" /></div>}
      <div className="flex flex-col gap-1"><Label>Purchase order (optional)</Label><Input value={f.poId} onChange={set("poId")} placeholder="po-..." /></div>
    </div>
    {big && <p className="mt-3 text-xs text-warn">Limits over {money(threshold)} need your authenticator code and a second approver.</p>}
    <div className="mt-3 flex gap-2"><Button variant="primary" disabled={busy || f.label.trim().length < 2} onClick={submit}>{big ? "Ask for approval" : "Issue card"}</Button></div>
    <ErrorNote msg={error} /><StepUpIfNeeded error={error} threshold={threshold} />
  </Card>;
}

export function CardsPage() {
  const { data, isLoading } = useGet<ListResp>("/cards"); const { data: me } = useMe();
  const [open, setOpen] = useState(false); const nav = useNavigate();
  return <Section>
    <PageHeader title="Cards" sub="Virtual cards for one purchase, one supplier, monthly spend or an AI agent. You only ever see the last 4 digits." actions={can(me, "flow.operate") ? <Button variant="primary" onClick={() => setOpen(!open)}><Plus size={14} aria-hidden />Issue card</Button> : undefined} />
    {data?.issuer && <IssuerNote i={data.issuer} />}
    {open && data && <IssueForm threshold={data.stepUpThresholdUsd} onDone={(id) => { setOpen(false); nav(`/app/cards/${id}`); }} />}
    {isLoading ? <Card pad={false}><SkeletonTable rows={4} cols={5} /></Card> : !data?.cards.length
      ? <EmptyState icon={CreditCard} title="No cards yet" body="Issue a card to pay a supplier or to give an agent a budget." />
      : <Card pad={false}><Table head={["Card", "Type", "Owner", "Status", "Used", ""]}>{data.cards.map((c) => <tr key={c.id} className="border-t border-border">
          <td className="px-3 py-2"><Link className="font-medium text-primary hover:underline" to={`/app/cards/${c.id}`}>{c.label}</Link><div><Mono className="text-muted">{masked(c.last4)}</Mono></div></td>
          <td className="px-3 py-2 text-[13px]">{c.typeText}</td><td className="px-3 py-2 text-[13px]">{c.owner}</td>
          <td className="px-3 py-2"><Badge v={STATUS_TEXT[c.status] ?? c.status} tone={statusTone(c.status)} /></td>
          <td className="px-3 py-2 tabular-nums text-[13px]">{money(c.spent, c.currency)} of {money(c.limit, c.currency)}</td>
          <td className="px-3 py-2 text-right"><Muted>{c.issuerLabel}</Muted></td></tr>)}</Table></Card>}
  </Section>;
}

function Simulator({ c }: { c: CardView }) {
  const { run, busy, error } = useAct();
  const [f, setF] = useState({ merchant: c.allowedMerchants[0] ?? "", mcc: c.allowedMccs[0] ?? "", amount: "25" });
  const [res, setRes] = useState<{ decision: { approved: boolean; reason: string }; note: string | null } | null>(null);
  const go = async () => { const r = await run(() => api<any>(`/cards/${c.id}/simulate`, { merchant: f.merchant, mcc: f.mcc, amount: Number(f.amount) })); if (r) setRes(r); };
  return <Card title="Try a charge">
    <p className="mb-3 text-xs text-muted">Pick a merchant and an amount to see if this card would approve or decline. {c.issuer === "stripe" ? "This creates a Stripe test authorization." : "The simulated issuer decides with the same rules."}</p>
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1"><Label>Merchant</Label><Input list={`m-${c.id}`} value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} /><datalist id={`m-${c.id}`}>{[...c.allowedMerchants, "Random Store"].map((m) => <option key={m} value={m} />)}</datalist></div>
      <div className="flex flex-col gap-1"><Label>MCC</Label><Input className="w-24" maxLength={4} value={f.mcc} onChange={(e) => setF({ ...f, mcc: e.target.value.replace(/\D/g, "") })} /></div>
      <div className="flex flex-col gap-1"><Label>Amount ({c.currency})</Label><Input className="w-32" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
      <Button variant="primary" disabled={busy || !f.merchant || !(Number(f.amount) > 0)} onClick={go}>Run</Button>
    </div>
    {res && <div role="status" className={`mt-3 rounded-md border px-3 py-2 text-[13px] ${res.decision.approved ? "border-ok/30 bg-ok/10" : "border-bad/30 bg-bad/10"}`}><span className="font-semibold">{res.decision.approved ? "Approved" : "Declined"}.</span> {res.decision.reason.replace(/^(Approved|Declined)\. /, "")}{res.note && <div className="text-xs text-muted">{res.note}</div>}</div>}
    <ErrorNote msg={error} />
  </Card>;
}

function Controls({ c, threshold }: { c: CardView; threshold: number }) {
  const { run, busy, error } = useAct(); const { data: me } = useMe();
  const a = actionsFor(c.status); const [limit, setLimit] = useState(String(c.limit));
  const [shown, setShown] = useState<{ number: string; cvc: string; expiry: string; note: string } | null>(null);
  const act = (path: string, body: any = {}) => run(() => api(`/cards/${c.id}/${path}`, body));
  return <Card title="Controls">
    <div className="flex flex-wrap gap-2">
      {a.freeze && <Button disabled={busy} onClick={() => act("freeze")}>Freeze</Button>}
      {a.unfreeze && <Button disabled={busy} onClick={() => act("unfreeze")}>Unfreeze</Button>}
      {a.cancel && <Button disabled={busy} onClick={() => { if (confirm("Cancel this card? This cannot be undone.")) void act("cancel"); }}>Cancel card</Button>}
      {a.decide && can(me, "payments.approve") && <><Button variant="primary" disabled={busy} onClick={() => act("decide", { approve: true })}>Approve card</Button><Button disabled={busy} onClick={() => act("decide", { approve: false })}>Reject</Button></>}
      {c.last4 && <Button disabled={busy} onClick={async () => { const r = await act("reveal"); if (r) setShown(r as any); }}>Reveal</Button>}
    </div>
    {a.limit && <div className="mt-3 flex items-end gap-2"><div className="flex flex-col gap-1"><Label>New limit ({c.currency})</Label><Input className="w-36" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></div><Button disabled={busy || !(Number(limit) > 0)} onClick={() => act("limit", { limit: Number(limit) })}>Change limit</Button></div>}
    {shown && <div className="mt-3 rounded-md border border-border bg-subtle p-3 text-[13px]"><Mono>{shown.number}</Mono> <Mono>CVC {shown.cvc}</Mono> <Mono>Exp {shown.expiry}</Mono><div className="mt-1 text-xs text-muted">{shown.note}</div></div>}
    <ErrorNote msg={error} /><StepUpIfNeeded error={error} threshold={threshold} />
  </Card>;
}

export function CardDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useGet<{ card: CardView; authorizations: CardAuth[] }>(`/cards/${id}`);
  const { data: list } = useGet<ListResp>("/cards");
  if (isLoading) return <Section><Card pad={false}><SkeletonTable rows={4} cols={4} /></Card></Section>;
  if (!data) return <Section><ErrorNote msg={(error as any)?.message ?? "Card not found"} /></Section>;
  const c = data.card; const threshold = list?.stepUpThresholdUsd ?? 10000;
  return <Section>
    <PageHeader title={c.label} sub={`${c.typeText} card for ${c.owner}. ${c.issuerLabel}.`} actions={<Link to="/app/cards" className="text-[13px] text-primary hover:underline">All cards</Link>} />
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2" title="Card">
        <div className="flex flex-wrap items-center gap-3"><Mono className="text-base">{masked(c.last4)}</Mono><Muted>Exp {c.expiry}</Muted><Badge v={STATUS_TEXT[c.status] ?? c.status} tone={statusTone(c.status)} /></div>
        <div className="mt-3"><LimitBar c={c} /></div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-3">
          <div><dt className="text-xs text-muted">Allowed merchants</dt><dd>{c.allowedMerchants.join(", ") || "Any"}</dd></div>
          <div><dt className="text-xs text-muted">Allowed MCC</dt><dd>{c.allowedMccs.join(", ") || "Any"}</dd></div>
          <div><dt className="text-xs text-muted">Purchase order</dt><dd>{c.poId ?? "None"}</dd></div>
          <div><dt className="text-xs text-muted">Asked for by</dt><dd>{c.createdByName}</dd></div>
          <div><dt className="text-xs text-muted">Approved by</dt><dd>{c.approvedBy ?? "Not needed"}</dd></div>
        </dl>
      </Card>
      <Controls c={c} threshold={threshold} />
    </div>
    {c.status !== "pending_approval" && c.status !== "rejected" && <Simulator key={c.id} c={c} />}
    <Card title="Authorization history" pad={false}>{!data.authorizations.length ? <div className="p-4"><Muted>No charges yet.</Muted></div> :
      <Table head={["When", "Merchant", "Amount", "Result", "Reason", "Source"]}>{data.authorizations.map((a) => <tr key={a.id} className="border-t border-border text-[13px]">
        <td className="px-3 py-2"><Muted>{new Date(a.createdAt).toLocaleString()}</Muted></td><td className="px-3 py-2">{a.merchant}{a.mcc && <Muted> MCC {a.mcc}</Muted>}</td>
        <td className="px-3 py-2 tabular-nums">{money(a.amount, a.currency)}</td><td className="px-3 py-2"><Badge v={a.approved ? "Approved" : "Declined"} tone={a.approved ? "ok" : "bad"} /></td>
        <td className="px-3 py-2">{a.reason}</td><td className="px-3 py-2"><Muted>{a.source === "stripe" ? "Stripe" : "Simulator"}</Muted></td></tr>)}</Table>}</Card>
  </Section>;
}
