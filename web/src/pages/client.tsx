import { useState } from "react";
import { Bot, FileText, Inbox, Wallet } from "lucide-react";
import { useGet } from "../lib/api";
import { usd } from "../lib/utils";
import { Card, EmptyState, Muted, PageHeader, Stat } from "../components/ui";
import { Section } from "../components/Shell";
import * as F from "./flows";

function useSt() { const s = F.useScopedState(); return s; }
const Wrap = ({ title, sub, children }: { title: string; sub?: string; children: (st: any) => React.ReactNode }) => {
  const { st, error } = useSt();
  return <Section><PageHeader title={title} sub={sub} />{st ? children(st) : <F.Loading error={error} />}</Section>;
};

export function ClientHome() {
  const [poId, setPoId] = useState<string>();
  const ev = useGet<any>("/evidence");
  return <Wrap title="Good to see you" sub="Your spend, approvals and agent activity at a glance">{(st) => {
    const spent = st.intents.filter((i: any) => i.status === "settled").reduce((a: number, i: any) => a + i.amount, 0);
    const pending = st.pos.filter((p: any) => p.status === "pending_approval").length;
    const openInv = st.invoices.filter((i: any) => !i.paid).length;
    const feed = (ev.data?.records ?? []).filter((r: any) => ["agent", "po", "invoice", "payment"].includes(r.subjectType)).slice(-8).reverse();
    const last = poId ?? st.pos[st.pos.length - 1]?.id;
    return <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Wallet} label="Paid this period" value={usd(spent)} />
        <Stat icon={Inbox} label="Waiting for approval" value={pending} />
        <Stat icon={FileText} label="Open invoices" value={openInv} />
        <Stat icon={Bot} label="Active agents" value={st.agents.filter((a: any) => a.status === "active").length} hint={st.killSwitch ? "Kill switch is on" : undefined} />
      </div>
      <Card title="Latest flow"><F.FlowTracker st={st} poId={last} /></Card>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <F.Scenarios onRun={(r) => setPoId(r.poId)} />
        <Card title="Agent activity" pad={false}>{st.agents.length && feed.length ? <ul className="divide-y divide-border">{feed.map((r: any) => <li key={r.id} className="px-4 py-2"><div className="text-[13px]">{r.event.replaceAll(".", " ")}</div><Muted>{r.subjectId} at {r.createdAt.slice(11, 19)}</Muted></li>)}</ul> : <EmptyState title="No agent activity yet" />}</Card>
      </div>
    </>;
  }}</Wrap>;
}
export const PurchaseOrders = () => <Wrap title="Purchase orders" sub="Agents draft, policy checks, people approve">{(st) => <><F.BuyerDraft /><F.PoTable st={st} /></>}</Wrap>;
export const Invoices = () => <Wrap title="Invoices" sub="Supplier invoices read by the model and matched against PO and goods receipt">{(st) => <><F.InvoiceDesk st={st} /><F.InvoiceTable st={st} /></>}</Wrap>;
export const Approvals = () => <Wrap title="Approvals" sub="Everything that needs a person">{(st) => <><F.ApprovalInbox st={st} /><F.PayeeChanges st={st} /><F.Alerts st={st} /></>}</Wrap>;
export const Agents = () => <Wrap title="Agents" sub="Identity, mandates and the kill switch">{(st) => <><F.AgentRegistry st={st} /><F.Mandates st={st} /><F.McpTools /></>}</Wrap>;
export const Suppliers = () => <Wrap title="Suppliers">{(st) => <F.SupplierTable st={st} />}</Wrap>;
export const Payments = () => <Wrap title="Payments" sub="Route, screen, sign and settle">{(st) => <><F.PaymentDesk st={st} /><F.ErpFeed st={st} /></>}</Wrap>;
export const Rules = () => <Wrap title="Rules" sub="Approval rules by amount, category and entity">{(st) => <><Card title="Current rule">{st.mandates[0] ? <p className="text-[13px]">Purchases above <b>{usd(st.mandates[0].approvalThreshold)}</b> need one human approver. The rest follow the agent mandate.</p> : <Muted>No rules yet.</Muted>}</Card>
  <Card><EmptyState title="Multi level rule designer is not built yet" body="You will add rules by amount, category and entity here. It ships in build step 4." /></Card></>}</Wrap>;
