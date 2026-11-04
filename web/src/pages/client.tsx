import { useState } from "react";
import { Bot, FileText, Inbox, Wallet } from "lucide-react";
import { useGet } from "../lib/api";
import { usd } from "../lib/utils";
import { Card, EmptyState, Muted, PageHeader, Stat } from "../components/ui";
import { Section } from "../components/Shell";
import * as F from "./flows";
import { PaymentsTable, RailStatus } from "./payments";
import * as Wk from "./workspace";
import { HomeStrip } from "./txflow";
import { ActivityFeed, HomeMixCharts } from "../components/live";

function useSt() { const s = F.useScopedState(); return s; }
const Wrap = ({ title, sub, children }: { title: string; sub?: string; children: (st: any) => React.ReactNode }) => {
  const { st, error } = useSt();
  return <Section><PageHeader title={title} sub={sub} />{st ? children(st) : <F.Loading error={error} />}</Section>;
};

export function ClientHome() {
  const [poId, setPoId] = useState<string>();
  return <Wrap title="Good to see you" sub="Your spend, approvals and agent activity at a glance">{(st) => {
    const spent = st.intents.filter((i: any) => i.status === "settled" && i.kind !== "refund").reduce((a: number, i: any) => a + i.amount, 0);
    const pending = st.pos.filter((p: any) => p.status === "pending_approval").length;
    const openInv = st.invoices.filter((i: any) => !i.paid).length;
    const last = poId ?? st.pos[st.pos.length - 1]?.id;
    return <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Wallet} label="Paid this period" value={usd(spent)} />
        <Stat icon={Inbox} label="Waiting for approval" value={pending} />
        <Stat icon={FileText} label="Open invoices" value={openInv} />
        <Stat icon={Bot} label="Active agents" value={st.agents.filter((a: any) => a.status === "active").length} hint={st.killSwitch ? "Kill switch is on" : undefined} />
      </div>
      <HomeStrip />
      <HomeMixCharts st={st} />
      <Card title="Latest flow"><F.FlowTracker st={st} poId={last} /></Card>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <F.Scenarios onRun={(r) => setPoId(r.poId)} />
        <ActivityFeed prefix="/app" />
      </div>
    </>;
  }}</Wrap>;
}
export const PurchaseOrders = () => <Wrap title="Purchase orders" sub="Agents draft, policy checks, people approve">{(st) => <><F.BuyerDraft /><F.PoTable st={st} /></>}</Wrap>;
export const Invoices = () => <Wrap title="Invoices" sub="Supplier invoices read by the model and matched against PO and goods receipt">{(st) => <><F.InvoiceDesk st={st} /><F.InvoiceTable st={st} /></>}</Wrap>;
export const Approvals = () => <Wrap title="Approvals" sub="Routed by your rules. Approve or reject with a comment.">{(st) => <><Wk.ApprovalsInbox /><F.PayeeChanges st={st} /><F.Alerts st={st} /></>}</Wrap>;
export const Agents = () => <><Wk.AgentsPage /><div className="mt-4"><F.McpTools /></div></>;
export const Suppliers = Wk.SuppliersPage;
export const Payments = () => <Wrap title="Payments" sub="Route, screen and submit. Payments settle when the rail confirms.">{(st) => <><F.PaymentDesk st={st} /><PaymentsTable /><RailStatus /><F.ErpFeed st={st} /></>}</Wrap>;
export const Rules = Wk.RulesPage;
