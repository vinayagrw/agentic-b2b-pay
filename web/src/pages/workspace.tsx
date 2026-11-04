import { useState } from "react";
import { ArrowDown, ArrowUp, Bot, Check, Copy, KeyRound, Plus, Power, Trash2, UserPlus, Workflow, X } from "lucide-react";
import { RAIL_LABEL, type Rail } from "@b2b/shared";
import { api, useAct, useGet, useMe } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Table, Textarea } from "../components/ui";
import { Section } from "../components/Shell";
import { Loading } from "./flows";

const CATS = ["mro", "components", "logistics", "it"] as const;
const CAT_LABEL: Record<string, string> = { mro: "MRO", components: "Components", logistics: "Logistics", it: "IT" };
const RAILS = Object.keys(RAIL_LABEL) as Rail[];
const roleName = (r: string) => (r === "client_admin" ? "Client admin" : r === "approver" ? "Approver" : r);
const inDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

function Toggle<T extends string>({ all, value, onChange, label = (x: T) => x }: { all: readonly T[]; value: T[]; onChange: (v: T[]) => void; label?: (x: T) => string }) {
  return <div className="flex flex-wrap gap-1">{all.map((x) => { const on = value.includes(x); return <button key={x} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((y) => y !== x) : [...value, x])} className={on ? "rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-white" : "rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-subtle"}>{label(x)}</button>; })}</div>;
}
function Reveal({ secret, onDone, what }: { secret: string; onDone: () => void; what: string }) {
  const [copied, setCopied] = useState(false);
  return <div role="status" className="rounded-lg border border-warn/40 bg-warn/10 p-3">
    <div className="text-[13px] font-medium">Copy the {what} now. It is shown only once.</div>
    <div className="mt-2 flex items-center gap-2"><Mono className="flex-1 break-all rounded bg-surface px-2 py-1">{secret}</Mono>
      <Button size="sm" onClick={() => { navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => setCopied(false)); }}><Copy size={13} />{copied ? "Copied" : "Copy"}</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>I saved it</Button></div>
  </div>;
}

// Agents

type MandateForm = { perTxnMax: number; monthlyLimit: number; allowedCategories: string[]; allowedRails: string[]; validTo: string };
function MandateEditor({ value, onChange }: { value: MandateForm; onChange: (v: MandateForm) => void }) {
  return <div className="grid gap-3 sm:grid-cols-2">
    <div><Label>Per transaction limit (USD)</Label><Input type="number" min={1} value={value.perTxnMax} onChange={(e) => onChange({ ...value, perTxnMax: Number(e.target.value) })} /></div>
    <div><Label>Monthly limit (USD)</Label><Input type="number" min={1} value={value.monthlyLimit} onChange={(e) => onChange({ ...value, monthlyLimit: Number(e.target.value) })} /></div>
    <div className="sm:col-span-2"><Label>Categories</Label><Toggle all={CATS} value={value.allowedCategories as any} onChange={(v) => onChange({ ...value, allowedCategories: v })} label={(x) => CAT_LABEL[x]} /></div>
    <div className="sm:col-span-2"><Label>Allowed rails</Label><Toggle all={RAILS} value={value.allowedRails as any} onChange={(v) => onChange({ ...value, allowedRails: v })} label={(x) => RAIL_LABEL[x]} /></div>
    <div><Label>Expires on</Label><Input type="date" value={value.validTo.slice(0, 10)} onChange={(e) => onChange({ ...value, validTo: e.target.value })} /></div>
  </div>;
}
export function AgentsPage() {
  const { data, error } = useGet<any[]>("/workspace/agents"); const { data: me } = useMe();
  const { run, busy, error: e2 } = useAct();
  const [open, setOpen] = useState(false); const [secret, setSecret] = useState(""); const [edit, setEdit] = useState<string | null>(null);
  const [name, setName] = useState(""); const [m, setM] = useState<MandateForm>({ perTxnMax: 5000, monthlyLimit: 20000, allowedCategories: ["mro"], allowedRails: ["stripe_ach", "onchain_usdc"], validTo: inDays(90) });
  const [em, setEm] = useState<MandateForm | null>(null);
  const admin = me && ["client_admin", "operator_admin"].includes(me.user.role);
  const st = useGet<any>("/state");
  const create = async () => { const r = await run(() => api("/workspace/agents", { name, mandate: { ...m, validTo: new Date(m.validTo).toISOString() } })); if (r) { setSecret(r.key.key); setOpen(false); setName(""); } };
  const act = (id: string, a: string) => { if (a === "kill" && !confirm("Kill this agent? Its keys are revoked and it cannot be resumed.")) return; run(() => api(`/workspace/agents/${id}/${a}`, {})); };
  if (!data) return <Loading error={error as Error} />;
  return <Section>
    <PageHeader title="Agents" sub="Each agent has a signed mandate, a scoped key and a kill switch. Every change is in the audit log." actions={<>
      {admin && <Button variant={st.data?.killSwitch ? "outline" : "danger"} disabled={busy} onClick={() => run(() => api("/kill-switch", { on: !st.data?.killSwitch }))}><Power size={13} />{st.data?.killSwitch ? "Release kill switch" : "Kill switch, all agents"}</Button>}
      {admin && <Button variant="primary" onClick={() => setOpen(!open)}><Plus size={13} />Register agent</Button>}</>} />
    <ErrorNote msg={e2} />
    {st.data?.killSwitch && <div className="rounded-md bg-bad/10 px-3 py-2 text-xs font-medium text-bad">The kill switch is on. No agent can move money.</div>}
    {secret && <Reveal secret={secret} what="agent key" onDone={() => setSecret("")} />}
    {open && <Card title="Register an agent">
      <div className="flex flex-col gap-3"><div><Label>Agent name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spares buyer" /></div>
        <MandateEditor value={m} onChange={setM} />
        <div className="flex gap-2"><Button variant="primary" disabled={busy || name.length < 2} onClick={create}>Register and issue key</Button><Button onClick={() => setOpen(false)}>Cancel</Button></div></div>
    </Card>}
    {!data.length ? <Card><EmptyState icon={Bot} title="No agents yet" body="Register an agent to give it a mandate and a key." /></Card> :
      <div className="grid gap-3 lg:grid-cols-2">{data.map((a) => {
        const mm = a.mandate; const month = a.usage.month; const pct = mm?.monthlyLimit ? Math.min(100, (month.settled / mm.monthlyLimit) * 100) : 0;
        return <Card key={a.id} title={<span className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-accent/15 text-accent"><Bot size={14} /></span>{a.name}</span>} action={<><Badge v={a.killed ? "killed" : a.status} /><Badge v={`KYA ${a.kyaStatus}`} /></>}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-subtle p-2"><div className="text-[11px] text-muted">Settled this month</div><div className="font-semibold tabular-nums">{usd(month.settled)}</div></div>
              <div className="rounded-lg bg-subtle p-2"><div className="text-[11px] text-muted">Payments</div><div className="font-semibold tabular-nums">{a.usage.total.count}</div></div>
              <div className="rounded-lg bg-subtle p-2"><div className="text-[11px] text-muted">Settled total</div><div className="font-semibold tabular-nums">{usd(a.usage.total.settled)}</div></div>
            </div>
            {mm && <div><div className="flex text-[11px] text-muted"><span>Monthly limit</span><span className="ml-auto tabular-nums">{usd(month.settled)} of {usd(mm.monthlyLimit ?? mm.maxAmount)}</span></div><div className="mt-1 h-1.5 rounded-full bg-subtle"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${pct}%` }} /></div></div>}
            {edit === a.id && em ? <><MandateEditor value={em} onChange={setEm} /><div className="flex gap-2"><Button size="sm" variant="primary" disabled={busy} onClick={async () => { if (await run(() => api(`/workspace/agents/${a.id}/mandate`, { ...em, validTo: new Date(em.validTo).toISOString() }, { method: "PUT" }))) setEdit(null); }}>Save mandate</Button><Button size="sm" onClick={() => setEdit(null)}>Cancel</Button></div></> :
              mm && <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs"><dt className="text-muted">Per transaction</dt><dd className="tabular-nums">{usd(mm.perTxnMax)}</dd><dt className="text-muted">Categories</dt><dd>{mm.allowedCategories.map((c: string) => CAT_LABEL[c]).join(", ")}</dd><dt className="text-muted">Rails</dt><dd>{mm.allowedRails.map((r: Rail) => RAIL_LABEL[r]).join(", ")}</dd><dt className="text-muted">Expires</dt><dd>{mm.validTo.slice(0, 10)}</dd></dl>}
            <div className="text-xs"><span className="text-muted">Keys </span>{a.keys.length ? a.keys.map((k: any) => <span key={k.id} className="mr-2"><Mono>{k.prefix}...</Mono> <Badge v={k.revokedAt ? "revoked" : "active"} /></span>) : <Muted>No scoped key yet</Muted>}</div>
            {admin && <div className="flex flex-wrap gap-1.5">
              {mm && edit !== a.id && !a.killed && <Button size="sm" onClick={() => { setEdit(a.id); setEm({ perTxnMax: mm.perTxnMax, monthlyLimit: mm.monthlyLimit ?? mm.maxAmount, allowedCategories: mm.allowedCategories, allowedRails: mm.allowedRails, validTo: mm.validTo }); }}>Edit mandate</Button>}
              {!a.killed && a.status === "active" && <Button size="sm" disabled={busy} onClick={async () => { const k = await run(() => api(`/workspace/agents/${a.id}/keys`, {})); if (k) setSecret(k.key); }}><KeyRound size={13} />New key</Button>}
              {!a.killed && <Button size="sm" disabled={busy} onClick={() => act(a.id, a.status === "active" ? "suspend" : "resume")}>{a.status === "active" ? "Suspend" : "Resume"}</Button>}
              {!a.killed && <Button size="sm" variant="danger" disabled={busy} onClick={() => act(a.id, "kill")}><Power size={13} />Kill</Button>}
            </div>}
          </div>
        </Card>; })}</div>}
  </Section>;
}

// Rules

type Rule = { id?: string; name: string; active: boolean; minAmount: number; maxAmount: number | null; categories: string[]; entities: string[]; levels: { role: "approver" | "client_admin"; count: number }[]; position?: number };
const blank = (): Rule => ({ name: "", active: true, minAmount: 0, maxAmount: null, categories: [], entities: [], levels: [{ role: "approver", count: 1 }] });
function RuleForm({ rule, suppliers, onSave, onCancel, busy }: { rule: Rule; suppliers: any[]; onSave: (r: Rule) => void; onCancel: () => void; busy: boolean }) {
  const [r, setR] = useState<Rule>(rule);
  return <div className="flex flex-col gap-3">
    <div className="grid gap-3 sm:grid-cols-3"><div><Label>Rule name</Label><Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></div>
      <div><Label>From amount (USD)</Label><Input type="number" min={0} value={r.minAmount} onChange={(e) => setR({ ...r, minAmount: Number(e.target.value) })} /></div>
      <div><Label>Up to, not including (blank for no cap)</Label><Input type="number" min={0} value={r.maxAmount ?? ""} onChange={(e) => setR({ ...r, maxAmount: e.target.value === "" ? null : Number(e.target.value) })} /></div></div>
    <div><Label>Categories, none picked means any</Label><Toggle all={CATS} value={r.categories as any} onChange={(v) => setR({ ...r, categories: v })} label={(x) => CAT_LABEL[x]} /></div>
    <div><Label>Suppliers, none picked means any</Label><Toggle all={suppliers.map((s) => s.id)} value={r.entities} onChange={(v) => setR({ ...r, entities: v })} label={(x) => suppliers.find((s) => s.id === x)?.name ?? x} /></div>
    <div><Label>Approval levels, in order</Label>
      <ol className="mt-1 flex flex-col gap-1.5">{r.levels.map((l, n) => <li key={n} className="flex items-center gap-2"><Badge v={`Level ${n + 1}`} tone="primary" />
        <Select value={l.role} onChange={(e) => setR({ ...r, levels: r.levels.map((x, i) => (i === n ? { ...x, role: e.target.value as any } : x)) })}><option value="approver">Approver</option><option value="client_admin">Client admin</option></Select>
        <Input type="number" min={1} max={5} className="w-20" aria-label="Approvers needed" value={l.count} onChange={(e) => setR({ ...r, levels: r.levels.map((x, i) => (i === n ? { ...x, count: Number(e.target.value) } : x)) })} /><Muted>approvers needed</Muted>
        {r.levels.length > 1 && <Button size="icon" variant="ghost" aria-label="Remove level" onClick={() => setR({ ...r, levels: r.levels.filter((_, i) => i !== n) })}><X size={14} /></Button>}</li>)}</ol>
      {r.levels.length < 4 && <Button size="sm" variant="ghost" className="mt-1" onClick={() => setR({ ...r, levels: [...r.levels, { role: "client_admin", count: 1 }] })}><Plus size={13} />Add level</Button>}</div>
    <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={r.active} onChange={(e) => setR({ ...r, active: e.target.checked })} />Active</label>
    <div className="flex gap-2"><Button variant="primary" disabled={busy || !r.name} onClick={() => onSave(r)}>Save rule</Button><Button onClick={onCancel}>Cancel</Button></div>
  </div>;
}
const band = (r: Rule) => r.maxAmount === null ? `${usd(r.minAmount)} and up` : `${usd(r.minAmount)} to under ${usd(r.maxAmount)}`;
export function RulesPage() {
  const { data, error } = useGet<Rule[]>("/workspace/rules"); const sup = useGet<any[]>("/workspace/suppliers"); const { data: me } = useMe();
  const { run, busy, error: e2 } = useAct(); const [edit, setEdit] = useState<Rule | null>(null);
  const admin = me && ["client_admin", "operator_admin"].includes(me.user.role);
  if (!data) return <Loading error={error as Error} />;
  const save = async (r: Rule) => { const { id, position, ...body } = r as any; if (await run(() => id ? api(`/workspace/rules/${id}`, body, { method: "PUT" }) : api("/workspace/rules", body))) setEdit(null); };
  const move = (i: number, d: number) => { const ids = data.map((r) => r.id!); [ids[i], ids[i + d]] = [ids[i + d], ids[i]]; run(() => api("/workspace/rules/order", { ids })); };
  return <Section>
    <PageHeader title="Rules" sub="The first rule that matches a purchase decides who approves it. Agents never approve their own spend." actions={admin && !edit && <Button variant="primary" onClick={() => setEdit(blank())}><Plus size={13} />New rule</Button>} />
    <ErrorNote msg={e2} />
    {edit && <Card title={edit.id ? `Edit ${edit.name}` : "New rule"}><RuleForm rule={edit} suppliers={sup.data ?? []} busy={busy} onSave={save} onCancel={() => setEdit(null)} /></Card>}
    <Card title="Rules in order" pad={false}>{!data.length ? <EmptyState icon={Workflow} title="No rules" body="Without rules, purchases above the mandate threshold need one approver." /> :
      <ol className="divide-y divide-border">{data.map((r, i) => <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-medium">{r.name}{!r.active && <Badge v="off" tone="neutral" />}</div>
          <Muted>{band(r)}. {r.categories.length ? r.categories.map((c) => CAT_LABEL[c]).join(", ") : "Any category"}. {r.entities.length ? r.entities.map((e) => sup.data?.find((s) => s.id === e)?.name ?? e).join(", ") : "Any supplier"}.</Muted>
          <div className="mt-1 flex flex-wrap items-center gap-1">{r.levels.map((l, n) => <span key={n} className="flex items-center gap-1">{n > 0 && <span className="text-muted">then</span>}<Badge v={`${l.count} ${roleName(l.role)}${l.count > 1 ? "s" : ""}`} tone="primary" /></span>)}</div></div>
        {admin && <div className="flex gap-1"><Button size="icon" variant="ghost" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></Button><Button size="icon" variant="ghost" aria-label="Move down" disabled={busy || i === data.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></Button>
          <Button size="sm" onClick={() => setEdit(r)}>Edit</Button><Button size="icon" variant="ghost" aria-label="Delete rule" disabled={busy} onClick={() => confirm(`Delete ${r.name}?`) && run(() => api(`/workspace/rules/${r.id}`, undefined, { method: "DELETE" }))}><Trash2 size={14} /></Button></div>}
      </li>)}</ol>}</Card>
  </Section>;
}

// Approvals inbox

function ApprovalCard({ p }: { p: any }) {
  const { run, busy, error } = useAct(); const [comment, setComment] = useState("");
  const decide = (approve: boolean) => run(() => api(`/approvals/${p.id}`, { approve, comment }));
  return <Card className={p.status === "pending_approval" ? "" : "opacity-80"}>
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1"><div className="text-[13px] text-muted">{p.supplier}</div><div className="text-2xl font-semibold tabular-nums">{usd(p.total)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5"><span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent"><Bot size={11} />{p.agent}</span><Badge v={CAT_LABEL[p.category] ?? p.category} tone="neutral" /><Mono className="text-muted">{p.id}</Mono></div></div>
      <Badge v={p.status === "pending_approval" ? "waiting" : p.status} />
    </div>
    <p className="mt-2 text-[13px]">{p.justification}</p>
    <ul className="mt-1 text-xs text-muted">{p.lines.map((l: any) => <li key={l.sku}>{l.qty} x {l.description} at {usd(l.unitPrice)}</li>)}</ul>
    {p.approval && <div className="mt-3 rounded-lg bg-subtle p-3"><div className="text-xs font-medium">Rule: {p.approval.ruleName}</div>
      <ol className="mt-2 flex flex-col gap-1">{p.approval.levels.map((l: any, n: number) => { const done = l.approvals.length >= l.count; const cur = n === p.approval.current && p.status === "pending_approval";
        return <li key={n} className="flex flex-wrap items-center gap-2 text-xs"><span className={done ? "grid h-5 w-5 place-items-center rounded-full bg-ok text-white" : cur ? "grid h-5 w-5 place-items-center rounded-full bg-primary text-white" : "grid h-5 w-5 place-items-center rounded-full bg-border"}>{done ? <Check size={11} /> : n + 1}</span>
          <span className="font-medium">{l.count} {roleName(l.role)}{l.count > 1 ? "s" : ""}</span>{l.approvals.map((a: any) => <span key={a.userId} className="text-muted">{a.name}{a.comment ? `: "${a.comment}"` : ""}</span>)}</li>; })}</ol>
      {p.approval.rejectedBy && <div className="mt-2 text-xs text-bad">Rejected by {p.approval.rejectedBy.name}{p.approval.rejectedBy.comment ? `: "${p.approval.rejectedBy.comment}"` : ""}</div>}</div>}
    {p.status === "pending_approval" && (p.canAct ? <div className="mt-3 flex flex-col gap-2"><Textarea className="min-h-12 font-sans text-[13px]" placeholder="Comment for the record (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="flex gap-2"><Button variant="primary" disabled={busy} onClick={() => decide(true)}><Check size={13} />Approve</Button><Button disabled={busy} onClick={() => decide(false)}><X size={13} />Reject</Button></div></div>
      : <Muted className="mt-3 block">{p.why}</Muted>)}
    <ErrorNote msg={error} />
  </Card>;
}
export function ApprovalsInbox() {
  const { data, error } = useGet<any[]>("/workspace/approvals"); const [tab, setTab] = useState<"mine" | "all" | "done">("mine");
  if (!data) return <Loading error={error as Error} />;
  const pending = data.filter((p) => p.status === "pending_approval"); const mine = pending.filter((p) => p.canAct);
  const list = tab === "mine" ? mine : tab === "all" ? pending : data.filter((p) => p.status !== "pending_approval");
  return <div className="flex flex-col gap-3">
    <div className="flex gap-1">{([["mine", `For you (${mine.length})`], ["all", `All waiting (${pending.length})`], ["done", "Decided"]] as const).map(([k, l]) => <Button key={k} size="sm" variant={tab === k ? "primary" : "ghost"} onClick={() => setTab(k)}>{l}</Button>)}</div>
    {!list.length ? <Card><EmptyState title={tab === "mine" ? "Inbox zero" : "Nothing here"} body="Purchases that match a rule, or go above the mandate threshold, land here for the right people." /></Card> : <div className="grid gap-3 lg:grid-cols-2">{list.map((p) => <ApprovalCard key={p.id} p={p} />)}</div>}
  </div>;
}

// Suppliers

async function signInBrowser(message: string): Promise<{ address: string; signature: string }> {
  const eth = (window as any).ethereum; if (!eth) throw new Error("No browser wallet found. Paste a signature instead.");
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  const hex = "0x" + Array.from(new TextEncoder().encode(message)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const signature = await eth.request({ method: "personal_sign", params: [hex, address] });
  return { address, signature };
}
export function WalletProof({ getMessage, onSubmit, busy }: { getMessage: (address: string) => Promise<string>; onSubmit: (address: string, signature: string) => Promise<unknown>; busy: boolean }) {
  const [address, setAddress] = useState(""); const [msg, setMsg] = useState(""); const [sig, setSig] = useState(""); const [err, setErr] = useState("");
  const viaWallet = async () => { setErr(""); try { const eth = (window as any).ethereum; if (!eth) throw new Error("No browser wallet found. Paste a signature instead."); const [a] = await eth.request({ method: "eth_requestAccounts" }); const m = await getMessage(a); setAddress(a); setMsg(m); const r = await signInBrowser(m); await onSubmit(r.address, r.signature); } catch (e: any) { setErr(e.message); } };
  return <div className="flex flex-col gap-2">
    <Button onClick={viaWallet} disabled={busy}>Sign with browser wallet</Button>
    <Muted>Or sign the message with any wallet tool and paste the signature.</Muted>
    <div className="flex gap-2"><Input placeholder="0x wallet address" value={address} onChange={(e) => setAddress(e.target.value.trim())} /><Button size="sm" disabled={!address} onClick={async () => { setErr(""); try { setMsg(await getMessage(address)); } catch (e: any) { setErr(e.message); } }}>Get message</Button></div>
    {msg && <><pre>{msg}</pre><Input placeholder="0x signature" value={sig} onChange={(e) => setSig(e.target.value.trim())} /><Button variant="primary" disabled={busy || !sig} onClick={async () => { setErr(""); try { await onSubmit(address, sig); } catch (e: any) { setErr(e.message); } }}>Verify signature</Button></>}
    <ErrorNote msg={err} />
  </div>;
}
function BankFields({ onSubmit, busy, label }: { onSubmit: (b: { holderName: string; routingNumber: string; accountNumber: string }) => void; busy: boolean; label: string }) {
  const [b, setB] = useState({ holderName: "", routingNumber: "", accountNumber: "" });
  return <div className="grid gap-2 sm:grid-cols-3"><div><Label>Account holder</Label><Input value={b.holderName} onChange={(e) => setB({ ...b, holderName: e.target.value })} /></div>
    <div><Label>Routing number</Label><Input inputMode="numeric" value={b.routingNumber} onChange={(e) => setB({ ...b, routingNumber: e.target.value.trim() })} placeholder="110000000" /></div>
    <div><Label>Account number</Label><Input inputMode="numeric" value={b.accountNumber} onChange={(e) => setB({ ...b, accountNumber: e.target.value.trim() })} placeholder="000123456789" /></div>
    <div className="sm:col-span-3"><Button variant="primary" disabled={busy || !b.holderName || !b.routingNumber || !b.accountNumber} onClick={() => onSubmit(b)}>{label}</Button> <Muted>Stripe test bank numbers work: routing 110000000, account 000123456789.</Muted></div></div>;
}
function SupplierRow({ s, me }: { s: any; me: any }) {
  const { run, busy, error } = useAct(); const [open, setOpen] = useState(false); const [note, setNote] = useState(""); const [link, setLink] = useState(""); const [change, setChange] = useState<"" | "bank" | "wallet">("");
  const o = s.onboarding; const role = me.user.role;
  return <li className="px-4 py-3">
    <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><Muted>{s.id} . {s.acceptedRails.length ? s.acceptedRails.map((r: Rail) => RAIL_LABEL[r]).join(", ") : "No payout method yet"}</Muted></div>
      <Badge v={s.status} tone={s.status === "verified" ? "ok" : s.status === "rejected" ? "bad" : s.status === "submitted" ? "primary" : "warn"} />
      {s.pendingChanges.length > 0 && <Badge v={`${s.pendingChanges.length} payee change waiting`} tone="warn" />}
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? "Close" : "Details"}</Button></div>
    {open && <div className="mt-3 flex flex-col gap-3 rounded-lg bg-subtle p-3">
      {o ? <Table>
        <tr><td className="text-muted">Invited</td><td>{o.email} on {o.invitedAt.slice(0, 10)}</td></tr>
        <tr><td className="text-muted">Legal name</td><td>{o.kyb?.legalName ?? "Not provided"}</td></tr>
        <tr><td className="text-muted">Tax id</td><td>{o.kyb ? `${o.kyb.taxIdType.toUpperCase()} ${o.kyb.taxId}` : "Not provided"}</td></tr>
        <tr><td className="text-muted">Address</td><td>{o.kyb ? `${o.kyb.address.line1}, ${o.kyb.address.city} ${o.kyb.address.postalCode}, ${o.kyb.address.country}` : ""}</td></tr>
        <tr><td className="text-muted">Owners</td><td>{o.kyb?.ubos.map((u: any) => `${u.name} ${u.ownershipPct} percent`).join(", ")}</td></tr>
        <tr><td className="text-muted">Bank</td><td>{o.bank ? <>Ending {o.bank.last4} {o.bank.bankName && `at ${o.bank.bankName}`} <Mono>{o.bank.tokenId}</Mono></> : "None"}</td></tr>
        <tr><td className="text-muted">Wallet</td><td>{o.wallet ? <><Mono>{o.wallet.address}</Mono> <Badge v="signature verified" tone="ok" /></> : "None"}</td></tr>
        <tr><td className="text-muted">Screening</td><td>{o.screening ? (o.screening.hits.length ? <Badge v={`${o.screening.hits.length} sanctions hit`} tone="bad" /> : <Badge v="clear" />) : "Runs on submit"}</td></tr>
        {o.reviewedBy && <tr><td className="text-muted">Review</td><td>{o.status} by {o.reviewedBy}{o.reviewNote ? `: ${o.reviewNote}` : ""}</td></tr>}
      </Table> : <Muted>Seeded supplier, verified before onboarding existed.</Muted>}
      {o && o.status !== "verified" && ["client_admin", "ap_clerk", "operator_admin"].includes(role) && <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={busy} onClick={async () => { const r = await run(() => api(`/workspace/suppliers/${s.id}/link`, {})); if (r) setLink(`${location.origin}${r.link}`); }}>New onboarding link</Button>{link && <Reveal secret={link} what="onboarding link" onDone={() => setLink("")} />}</div>}
      {o?.status === "submitted" && role === "client_admin" && <div className="flex flex-col gap-2"><Input placeholder="Review note" value={note} onChange={(e) => setNote(e.target.value)} /><div className="flex gap-2"><Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api(`/workspace/suppliers/${s.id}/review`, { verify: true, note }))}>Verify supplier</Button><Button size="sm" disabled={busy} onClick={() => run(() => api(`/workspace/suppliers/${s.id}/review`, { verify: false, note }))}>Reject</Button></div></div>}
      {s.status === "verified" && ["client_admin", "ap_clerk"].includes(role) && <div className="flex flex-col gap-2"><div className="flex gap-2"><Button size="sm" variant={change === "bank" ? "primary" : "outline"} onClick={() => setChange(change === "bank" ? "" : "bank")}>Change bank account</Button><Button size="sm" variant={change === "wallet" ? "primary" : "outline"} onClick={() => setChange(change === "wallet" ? "" : "wallet")}>Change wallet</Button></div>
        <Muted>Changes wait for an approver to check them before they apply.</Muted>
        {change === "bank" && <BankFields busy={busy} label="Request bank change" onSubmit={async (bank) => { if (await run(() => api(`/workspace/suppliers/${s.id}/payee-change`, { field: "bank", bank }))) setChange(""); }} />}
        {change === "wallet" && <WalletProof busy={busy} getMessage={async (address) => (await api(`/workspace/suppliers/${s.id}/wallet-message`, { address })).message} onSubmit={async (address, signature) => { await api(`/workspace/suppliers/${s.id}/payee-change`, { field: "wallet", address, signature }); setChange(""); await run(async () => null); }} />}</div>}
      {s.pendingChanges.map((c: any) => <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs"><Badge v="waiting for checker" tone="warn" />{c.payload.field === "bank" ? `Bank ending ${c.payload.bank.last4}` : <Mono>{c.payload.wallet.address}</Mono>}<Muted>requested by {c.requestedBy}</Muted>
        {role === "approver" && c.requestedBy !== me.user.id && <><Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => api(`/changes/${c.id}/decide`, { approve: true }))}>Approve change</Button><Button size="sm" disabled={busy} onClick={() => run(() => api(`/changes/${c.id}/decide`, { approve: false }))}>Reject</Button></>}</div>)}
      <ErrorNote msg={error} />
    </div>}
  </li>;
}
export function SuppliersPage() {
  const { data, error } = useGet<any[]>("/workspace/suppliers"); const { data: me } = useMe();
  const { run, busy, error: e2 } = useAct(); const [f, setF] = useState({ name: "", email: "", country: "US" }); const [link, setLink] = useState(""); const [open, setOpen] = useState(false);
  if (!data || !me) return <Loading error={error as Error} />;
  const can = ["client_admin", "ap_clerk", "operator_admin"].includes(me.user.role);
  const counts = ["draft", "submitted", "verified", "rejected"].map((k) => [k, data.filter((s) => s.status === k).length] as const);
  return <Section>
    <PageHeader title="Suppliers" sub="Invite a supplier, they fill in KYB, bank and wallet details, and a client admin verifies them." actions={can && <Button variant="primary" onClick={() => setOpen(!open)}><UserPlus size={13} />Invite supplier</Button>} />
    <div className="flex flex-wrap gap-2">{counts.map(([k, n]) => <Badge key={k} v={`${k} ${n}`} tone="neutral" />)}</div>
    {open && <Card title="Invite a supplier"><div className="grid gap-2 sm:grid-cols-[1fr_1fr_100px_auto]"><div><Label>Company name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div><div><Label>AP contact email</Label><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      <div><Label>Country</Label><Input maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></div>
      <div className="flex items-end"><Button variant="primary" disabled={busy || !f.name || !f.email} onClick={async () => { const r = await run(() => api("/workspace/suppliers/invite", f)); if (r) { setLink(`${location.origin}${r.link}`); setOpen(false); setF({ name: "", email: "", country: "US" }); } }}>Create link</Button></div></div><ErrorNote msg={e2} /></Card>}
    {link && <Reveal secret={link} what="onboarding link" onDone={() => setLink("")} />}
    <Card title="All suppliers" pad={false}>{data.length ? <ul className="divide-y divide-border">{data.map((s) => <SupplierRow key={s.id} s={s} me={me} />)}</ul> : <EmptyState title="No suppliers" />}</Card>
  </Section>;
}

// Public onboarding portal

export function OnboardPortal({ token }: { token: string }) {
  const { data, error, refetch } = useGet<any>(`/onboard/${token}`);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const call = async (path: string, body: unknown) => { setBusy(true); setErr(""); try { await api(`/onboard/${token}${path}`, body); await refetch(); return true; } catch (e: any) { setErr(e.message); return false; } finally { setBusy(false); } };
  const [k, setK] = useState<any>(null);
  if (error) return <EmptyState icon={UserPlus} title="This link does not work" body={(error as Error).message} />;
  if (!data) return <Loading />;
  const kyb = k ?? data.kyb ?? { legalName: data.name, taxIdType: "ein", taxId: "", address: { line1: "", city: "", postalCode: "", country: "US" }, ubos: [{ name: "", ownershipPct: 100, country: "US" }] };
  const set = (patch: any) => setK({ ...kyb, ...patch });
  const locked = !["draft", "rejected"].includes(data.status);
  return <div className="flex flex-col gap-4">
    <div className="flex items-center gap-2"><h1 className="text-lg font-semibold">Get paid by {data.tenant}</h1><Badge v={data.status} tone={data.status === "verified" ? "ok" : data.status === "rejected" ? "bad" : "warn"} /></div>
    <p className="text-[13px] text-muted">Fill in your company details and how you want to be paid. {data.tenant} reviews and verifies your details before the first payment.</p>
    {data.status === "rejected" && data.reviewNote && <ErrorNote msg={`Your details were sent back: ${data.reviewNote}`} />}
    {data.status === "submitted" && <div className="rounded-md bg-primary/10 px-3 py-2 text-[13px] text-primary">Thanks. Your details are with {data.tenant} for review.</div>}
    {data.status === "verified" && <div className="rounded-md bg-ok/10 px-3 py-2 text-[13px] text-ok">You are verified. Payments can now be sent to you.</div>}
    <ErrorNote msg={err} />
    <Card title="1. Company details">
      <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Label>Legal name</Label><Input value={kyb.legalName} onChange={(e) => set({ legalName: e.target.value })} /></div>
        <div><Label>Tax id type</Label><Select className="w-full" value={kyb.taxIdType} onChange={(e) => set({ taxIdType: e.target.value })}><option value="ein">US EIN</option><option value="vat">VAT number</option></Select></div>
        <div><Label>{kyb.taxIdType === "ein" ? "EIN, like 12-3456789" : "VAT number, like GB123456789"}</Label><Input value={kyb.taxId} onChange={(e) => set({ taxId: e.target.value })} /></div>
        <div className="sm:col-span-2"><Label>Street address</Label><Input value={kyb.address.line1} onChange={(e) => set({ address: { ...kyb.address, line1: e.target.value } })} /></div>
        <div><Label>City</Label><Input value={kyb.address.city} onChange={(e) => set({ address: { ...kyb.address, city: e.target.value } })} /></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>Postal code</Label><Input value={kyb.address.postalCode} onChange={(e) => set({ address: { ...kyb.address, postalCode: e.target.value } })} /></div><div><Label>Country</Label><Input maxLength={2} value={kyb.address.country} onChange={(e) => set({ address: { ...kyb.address, country: e.target.value.toUpperCase() } })} /></div></div>
        <div className="sm:col-span-2"><Label>Owners with 25 percent or more</Label>
          {kyb.ubos.map((u: any, n: number) => <div key={n} className="mt-1 grid grid-cols-[1fr_90px_70px_auto] gap-2"><Input placeholder="Full name" value={u.name} onChange={(e) => set({ ubos: kyb.ubos.map((x: any, i: number) => (i === n ? { ...x, name: e.target.value } : x)) })} />
            <Input type="number" min={25} max={100} aria-label="Ownership percent" value={u.ownershipPct} onChange={(e) => set({ ubos: kyb.ubos.map((x: any, i: number) => (i === n ? { ...x, ownershipPct: Number(e.target.value) } : x)) })} />
            <Input maxLength={2} aria-label="Owner country" value={u.country} onChange={(e) => set({ ubos: kyb.ubos.map((x: any, i: number) => (i === n ? { ...x, country: e.target.value.toUpperCase() } : x)) })} />
            {kyb.ubos.length > 1 ? <Button size="icon" variant="ghost" aria-label="Remove owner" onClick={() => set({ ubos: kyb.ubos.filter((_: any, i: number) => i !== n) })}><X size={14} /></Button> : <span />}</div>)}
          {kyb.ubos.length < 4 && <Button size="sm" variant="ghost" className="mt-1" onClick={() => set({ ubos: [...kyb.ubos, { name: "", ownershipPct: 25, country: kyb.address.country }] })}><Plus size={13} />Add owner</Button>}</div>
        <div><Button variant="primary" disabled={busy} onClick={async () => { if (await call("/kyb", kyb)) setK(null); }}>Save company details</Button> {data.kyb && <Badge v="saved" />}</div>
      </fieldset>
    </Card>
    <Card title="2. Bank account">
      {data.bank && <div className="mb-2 text-[13px]">Account ending <b>{data.bank.last4}</b>{data.bank.bankName && ` at ${data.bank.bankName}`} <Badge v="tokenized by Stripe" tone="ok" /></div>}
      {!data.stripeReady ? <Muted>Bank details need Stripe test keys on the platform. Not configured, so add a wallet instead or ask {data.tenant}.</Muted>
        : !locked && <BankFields busy={busy} label={data.bank ? "Replace bank account" : "Save bank account"} onSubmit={(b) => call("/bank", b)} />}
      <p className="mt-2 text-xs text-muted">Your account number goes straight to Stripe to create a bank token. Only the token and the last four digits are kept.</p>
    </Card>
    <Card title="3. Wallet for USDC payments, optional">
      {data.wallet ? <div className="text-[13px]"><Mono>{data.wallet.address}</Mono> <Badge v="ownership proven" tone="ok" /></div>
        : !locked && <WalletProof busy={busy} getMessage={async (address) => (await api(`/onboard/${token}/wallet-message`, { address })).message} onSubmit={(address, signature) => call("/wallet", { address, signature })} />}
    </Card>
    {!locked && <Button variant="primary" className="self-start" disabled={busy || !data.kyb || (!data.bank && !data.wallet)} onClick={() => call("/submit", {})}>Submit for review</Button>}
  </div>;
}
