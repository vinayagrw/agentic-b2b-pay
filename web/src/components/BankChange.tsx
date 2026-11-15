import { useState } from "react";
import { Check, Landmark, PhoneCall, ShieldAlert, X } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can, type StepUpStatus } from "../lib/perm";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Textarea } from "./ui";
import { SkeletonTable } from "./kit";
import { Section } from "./Shell";
import { StepUpPrompt } from "./ApprovalCard";

type Masked = { kind: "bank" | "wallet"; holderName: string | null; bankName: string | null; country: string | null; accountType: string; last4: string | null };
type Signal = { code: string; label: string; detail: string; tone: "bad" | "warn" | "neutral" };
export type BankChange = { id: string; tenantId: string; supplierId: string; supplierName: string; kind: "bank" | "wallet"; status: "pending" | "approved" | "rejected"; old: Masked; new: Masked; signals: Signal[];
  channel: string; channelText: string; channelNote: string; requestedBy: string; requestedByName: string | null; createdAt: string; callbackPhone: string | null;
  callback: { by: string; byName: string | null; at: string; phone: string; outcome: "confirmed" | "denied" | "no_answer"; spokeTo: string; note: string } | null;
  decidedBy: string | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null; holdUntil: string | null; coolingOff: boolean; paymentsHeld: boolean };
type ListResp = { requests: BankChange[]; settings: { coolingOffHours: number } | null };

const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "");
const acct = (m: Masked) => (m.last4 ? `${m.accountType} ending ${m.last4}` : m.kind === "wallet" ? "No wallet on file" : "On file, number not shown");
const OUTCOME = { confirmed: "Supplier confirmed the change", denied: "Supplier did not ask for this change", no_answer: "No answer" } as const;
const STATUS_TONE = { pending: "warn", approved: "ok", rejected: "bad" } as const;

/** Supplier page form. It only asks for a change. Nothing applies until a second person approves it. */
/** Call-back phone on the supplier record. People with suppliers.review can set it. The server locks it while a change waits. */
export function CallbackPhone({ supplierId, phone }: { supplierId: string; phone: string | null }) {
  const { data: me } = useMe(); const { run, busy, error } = useAct(); const [v, setV] = useState(""); const [edit, setEdit] = useState(false);
  return <div className="flex flex-col gap-1 text-[13px]" data-testid="callback-phone">
    <div className="flex flex-wrap items-center gap-2"><span className="text-muted">Call-back phone on file</span>{phone ? <Mono>{phone}</Mono> : <span>None. A bank detail change cannot be asked for until one is added.</span>}
      {can(me, "suppliers.review") && !edit && <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>{phone ? "Change" : "Add"}</Button>}</div>
    {edit && <div className="flex flex-wrap items-end gap-2"><div><Label>Phone number with country code</Label><Input className="w-56" inputMode="tel" placeholder="+44 20 7946 0000" value={v} onChange={(e) => setV(e.target.value)} /></div>
      <Button size="sm" variant="primary" disabled={busy || v.trim().length < 7} onClick={async () => { if (await run(() => api(`/suppliers/${supplierId}/callback-phone`, { phone: v }, { method: "PUT" }))) { setV(""); setEdit(false); } }}>Save</Button>
      <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>Cancel</Button><Muted>Use a number you already trust, not one from a change request.</Muted></div>}
    <ErrorNote msg={error} />
  </div>;
}

export function BankChangeForm({ supplierId, onDone }: { supplierId: string; onDone?: () => void }) {
  const { run, busy, error } = useAct();
  const [kind, setKind] = useState<"bank" | "wallet">("bank"); const [type, setType] = useState<"iban" | "local">("iban");
  const [b, setB] = useState({ holderName: "", bankName: "", country: "", iban: "", routingNumber: "", accountNumber: "" });
  const [address, setAddress] = useState(""); const [channel, setChannel] = useState("email"); const [note, setNote] = useState("");
  const ready = note.trim().length >= 3 && (kind === "wallet" ? /^0x[0-9a-fA-F]{40}$/.test(address) : !!b.holderName && !!b.bankName && b.country.length === 2 && (type === "iban" ? b.iban.length > 10 : !!b.routingNumber && !!b.accountNumber));
  const submit = async () => {
    const bank = type === "iban" ? { holderName: b.holderName, bankName: b.bankName, country: b.country, iban: b.iban } : { holderName: b.holderName, bankName: b.bankName, country: b.country, routingNumber: b.routingNumber, accountNumber: b.accountNumber };
    const r = await run(() => api(`/suppliers/${supplierId}/bank-changes`, kind === "wallet" ? { kind, wallet: { address }, channel, channelNote: note } : { kind, bank, channel, channelNote: note }));
    if (r) { setB({ holderName: "", bankName: "", country: "", iban: "", routingNumber: "", accountNumber: "" }); setAddress(""); setNote(""); onDone?.(); }
  };
  return <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3" data-testid="bank-change-form">
    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium"><Landmark size={14} aria-hidden />Change bank details</div>
    <Muted>This sends a request. A second person must call the supplier back and approve it. Payments to this supplier are held until then.</Muted>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant={kind === "bank" ? "primary" : "outline"} onClick={() => setKind("bank")}>Bank account</Button><Button size="sm" variant={kind === "wallet" ? "primary" : "outline"} onClick={() => setKind("wallet")}>Wallet</Button></div>
    {kind === "bank" ? <div className="grid gap-2 sm:grid-cols-3">
      <div><Label>Account holder</Label><Input value={b.holderName} onChange={(e) => setB({ ...b, holderName: e.target.value })} /></div>
      <div><Label>Bank name</Label><Input value={b.bankName} onChange={(e) => setB({ ...b, bankName: e.target.value })} /></div>
      <div><Label>Bank country (2 letters)</Label><Input maxLength={2} placeholder="DE" value={b.country} onChange={(e) => setB({ ...b, country: e.target.value.toUpperCase() })} /></div>
      <div><Label>Account type</Label><Select value={type} onChange={(e) => setType(e.target.value as "iban" | "local")}><option value="iban">IBAN</option><option value="local">Routing and account number</option></Select></div>
      {type === "iban" ? <div className="sm:col-span-2"><Label>IBAN</Label><Input autoComplete="off" value={b.iban} onChange={(e) => { const iban = e.target.value.toUpperCase(); setB({ ...b, iban, country: /^[A-Z]{2}/.test(iban) ? iban.slice(0, 2) : b.country }); }} /></div>
        : <><div><Label>Routing number</Label><Input inputMode="numeric" autoComplete="off" value={b.routingNumber} onChange={(e) => setB({ ...b, routingNumber: e.target.value.trim() })} /></div><div><Label>Account number</Label><Input inputMode="numeric" autoComplete="off" value={b.accountNumber} onChange={(e) => setB({ ...b, accountNumber: e.target.value.trim() })} /></div></>}
    </div> : <div><Label>New wallet address</Label><Input placeholder="0x..." autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value.trim())} /></div>}
    <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
      <div><Label>How did the request arrive</Label><Select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="email">Email</option><option value="phone">Phone</option><option value="portal">Supplier portal</option><option value="other">Other</option></Select></div>
      <div><Label>Describe how it was requested</Label><Textarea className="min-h-12 font-sans text-[13px]" placeholder="Who asked, when, and what they said. Do not paste account numbers here." value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </div>
    <div className="flex flex-wrap items-center gap-2"><Button variant="primary" disabled={busy || !ready} onClick={submit}>Send for a check</Button><Muted>While it waits, only the last 4 characters are shown. For an IBAN the country comes from its first 2 letters.</Muted></div>
    <ErrorNote msg={error} />
  </div>;
}

function Diff({ r }: { r: BankChange }) {
  const rows: [string, string, string][] = r.kind === "wallet" ? [["Wallet", acct(r.old), acct(r.new)]]
    : [["Account holder", r.old.holderName ?? "Not on file", r.new.holderName ?? ""], ["Bank", r.old.bankName ?? "Not on file", r.new.bankName ?? ""], ["Country", r.old.country ?? "Not on file", r.new.country ?? ""], ["Account", acct(r.old), acct(r.new)]];
  return <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-[13px]" data-testid="bank-change-diff">
    <thead><tr className="bg-subtle text-left text-xs text-muted"><th className="px-3 py-1.5 font-medium">Field</th><th className="px-3 py-1.5 font-medium">On file now</th><th className="px-3 py-1.5 font-medium">Requested</th></tr></thead>
    <tbody>{rows.map(([k, a, n]) => { const changed = a !== n; return <tr key={k} className="border-t border-border"><td className="px-3 py-1.5 text-muted">{k}</td><td className="px-3 py-1.5">{a}</td><td className={`px-3 py-1.5 ${changed ? "bg-warn/10 font-medium" : ""}`}>{n}{changed && <span className="sr-only"> (changed)</span>}</td></tr>; })}</tbody>
  </table></div>;
}

/** Review card: masked side-by-side diff, risk chips, the call-back form and Approve or Reject. */
export function BankChangeCard({ r }: { r: BankChange }) {
  const { data: me } = useMe(); const { run, busy, error } = useAct();
  const pending = r.status === "pending"; const isMaker = me?.user.id === r.requestedBy; const mayCheck = can(me, "payments.approve") && !isMaker;
  const { data: su } = useGet<StepUpStatus>("/auth/step-up", pending && mayCheck);
  const [cb, setCb] = useState({ outcome: "confirmed", spokeTo: "", note: "" }); const [note, setNote] = useState("");
  const confirmed = r.callback?.outcome === "confirmed"; const needCode = !!su && !su.fresh;
  return <Card className={pending ? "border-warn/40" : undefined} title={<span className="flex flex-wrap items-center gap-2">{r.supplierName}<Badge v={r.status === "pending" ? "waiting for a check" : r.status} tone={STATUS_TONE[r.status]} />{r.paymentsHeld && <Badge v="payments held" tone="bad" />}</span>}>
    <div className="flex flex-col gap-3" data-testid="bank-change-card">
      <Muted>{r.kind === "wallet" ? "Wallet change" : "Bank account change"} asked by {r.requestedByName ?? r.requestedBy} on {when(r.createdAt)}. <Mono>{r.id}</Mono></Muted>
      <Diff r={r} />
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium"><ShieldAlert size={13} aria-hidden />Risk signals</div>
        <div className="flex flex-wrap gap-1">{r.signals.map((s) => <Badge key={s.code} v={s.label} tone={s.tone} />)}</div>
        <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted">{r.signals.map((s) => <li key={s.code}>{s.detail}</li>)}</ul>
      </div>
      <div className="rounded-lg bg-subtle p-2.5 text-xs"><span className="font-medium">How it was requested.</span> {r.channelText}. {r.channelNote || "No description given."}</div>
      {r.paymentsHeld && <div className="rounded-lg border border-bad/30 bg-bad/10 p-2.5 text-xs" role="status">{pending ? "Payments to this supplier are held until this request is approved or rejected." : `Cooling-off time. Payments to this supplier are held until ${when(r.holdUntil)}.`}</div>}
      <div className="rounded-lg border border-border p-2.5">
        <div className="flex items-center gap-1.5 text-xs font-medium"><PhoneCall size={13} aria-hidden />Call-back</div>
        <p className="mt-1 text-xs text-muted">Call the number on the supplier record, not a number from the request. Number on file: {r.callbackPhone ? <Mono>{r.callbackPhone}</Mono> : "none. An admin must add one on the supplier page first"}</p>
        {r.callback && <p className="mt-1.5 text-xs"><Badge v={OUTCOME[r.callback.outcome]} tone={r.callback.outcome === "confirmed" ? "ok" : "bad"} /> {r.callback.byName ?? r.callback.by} called <Mono>{r.callback.phone}</Mono> on {when(r.callback.at)}{r.callback.spokeTo ? ` and spoke to ${r.callback.spokeTo}` : ""}.{r.callback.note ? ` ${r.callback.note}` : ""}</p>}
        {pending && mayCheck && <div className="mt-2 grid gap-2 sm:grid-cols-[220px_1fr]">
          <div><Label>Result of the call</Label><Select value={cb.outcome} onChange={(e) => setCb({ ...cb, outcome: e.target.value })}><option value="confirmed">Supplier confirmed the change</option><option value="denied">Supplier did not ask for this</option><option value="no_answer">No answer</option></Select></div>
          <div><Label>Person you spoke to</Label><Input value={cb.spokeTo} onChange={(e) => setCb({ ...cb, spokeTo: e.target.value })} /></div>
          <div className="sm:col-span-2"><Label>Call notes</Label><Input value={cb.note} onChange={(e) => setCb({ ...cb, note: e.target.value })} /></div>
          <div className="sm:col-span-2"><Button size="sm" disabled={busy || !r.callbackPhone || (cb.outcome === "confirmed" && cb.spokeTo.trim().length < 2)} onClick={async () => { if (await run(() => api(`/bank-changes/${r.id}/callback`, cb))) setCb({ outcome: "confirmed", spokeTo: "", note: "" }); }}>Record call-back</Button></div>
        </div>}
      </div>
      {pending && (mayCheck ? <div className="flex flex-col gap-2">
        {needCode && su && <StepUpPrompt s={su} threshold={su.thresholdUsd} text="Approving a bank detail change needs a fresh code from your authenticator app. It stays valid for a few minutes." />}
        <div><Label>Note for the record (needed to reject)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="flex flex-wrap gap-2 [&>button]:h-11 [&>button]:flex-1 sm:[&>button]:h-8 sm:[&>button]:flex-none">
          <Button variant="primary" disabled={busy || !confirmed || needCode} title={!confirmed ? "Record a confirmed call-back first" : needCode ? "Enter an authenticator code first" : undefined} onClick={() => run(() => api(`/bank-changes/${r.id}/decide`, { approve: true, note }))}><Check size={13} aria-hidden />Approve</Button>
          <Button variant="danger" disabled={busy || note.trim().length < 3} onClick={() => run(() => api(`/bank-changes/${r.id}/decide`, { approve: false, note }))}><X size={13} aria-hidden />Reject</Button>
        </div>
        {!confirmed && <Muted>Approve unlocks after a confirmed call-back and a fresh authenticator code.</Muted>}
      </div> : <Muted>{isMaker ? "You asked for this change, so another person must check it." : "Your role cannot approve payments, so you can read this but not decide."}</Muted>)}
      {!pending && <Muted>{r.status === "approved" ? "Approved" : "Rejected"} by {r.decidedByName ?? r.decidedBy} on {when(r.decidedAt)}.{r.decisionNote ? ` ${r.decisionNote}` : ""}</Muted>}
      <ErrorNote msg={error} />
    </div>
  </Card>;
}

/** Requests waiting for a check. Shown at the top of the risk inbox and on the supplier row. */
export function BankChangesWaiting({ supplierId }: { supplierId?: string }) {
  const { data } = useGet<ListResp>(`/bank-changes?status=${supplierId ? "all" : "pending"}${supplierId ? `&supplierId=${supplierId}` : ""}`);
  if (!data?.requests.length) return null;
  return <div className="grid gap-3 lg:grid-cols-2">{data.requests.slice(0, supplierId ? 3 : 20).map((r) => <BankChangeCard key={r.id} r={r} />)}</div>;
}

/** Full page: every request with a status filter and the cooling-off setting. */
export function BankChangesPage() {
  const [status, setStatus] = useState("pending");
  const { data, error } = useGet<ListResp>(`/bank-changes?status=${status}`); const { data: me } = useMe();
  const { run, busy, error: e2 } = useAct(); const [hours, setHours] = useState("");
  return <Section>
    <PageHeader title="Bank detail changes" sub="Changes asked for on the supplier page wait here. A second person calls the supplier back and approves with an authenticator code. Changes made through the older payee-change and ERP routes do not wait here, but payments are still held for the cooling-off time after them." actions={<div className="flex gap-1">{["pending", "approved", "rejected", "all"].map((s) => <Button key={s} size="sm" variant={status === s ? "primary" : "ghost"} onClick={() => setStatus(s)}>{s[0].toUpperCase() + s.slice(1)}</Button>)}</div>} />
    {error && <ErrorNote msg={(error as Error).message} />}
    {data?.settings && <Card title="Cooling-off time"><div className="flex flex-wrap items-end gap-2">
      <p className="min-w-0 flex-1 text-xs text-muted">After a change is approved, payments to that supplier stay held for {data.settings.coolingOffHours} hours. Bank account numbers are stored sealed and only the last 4 characters are shown. A wallet address shows only its last 4 characters while it waits, and in full on the supplier record once it is approved.</p>
      {can(me, "rules.edit") && <><div><Label>Hours</Label><Input className="w-24" inputMode="numeric" placeholder={String(data.settings.coolingOffHours)} value={hours} onChange={(e) => setHours(e.target.value.replace(/[^\d.]/g, ""))} /></div><Button size="sm" disabled={busy || hours === ""} onClick={async () => { if (await run(() => api("/bank-changes/settings", { coolingOffHours: Number(hours) }, { method: "PUT" }))) setHours(""); }}>Save</Button></>}
    </div><ErrorNote msg={e2} /></Card>}
    {!data ? <Card pad={false}><SkeletonTable rows={3} cols={3} /></Card> : data.requests.length ? <div className="grid gap-3 lg:grid-cols-2">{data.requests.map((r) => <BankChangeCard key={r.id} r={r} />)}</div>
      : <Card><EmptyState icon={Landmark} title="Nothing here" body="Ask for a change from the supplier page. It shows here for a second person to check." /></Card>}
  </Section>;
}
