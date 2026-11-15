import { useGet } from "../lib/api";
import type { EvidenceOrder } from "../lib/evidence";
import { Card, EmptyState, ErrorNote, Mono, PageHeader, Table } from "../components/ui";
import { SkeletonTable } from "../components/kit";
import { EvidenceButton } from "../components/Mandates";

/** Paid orders, each with a button that opens its dispute evidence record. */
export function EvidencePage() {
  const { data, error } = useGet<EvidenceOrder[]>("/evidence-orders");
  return <div className="space-y-4">
    <PageHeader title="Dispute evidence" sub="Paid orders. Open one to see its mandates, approvals, payment and audit events." />
    <Card>{error ? <ErrorNote msg={(error as any)?.message ?? "Could not load paid orders"} /> : !data ? <SkeletonTable /> : !data.length ? <EmptyState title="No paid orders yet" body="An order shows here once it is paid." /> :
      <Table head={["Order", "Supplier", "Amount", "Paid by", "Created", ""]}>{data.map((o) => <tr key={o.id}><td><Mono>{o.id}</Mono></td><td>{o.supplier}</td><td>{o.total.toLocaleString()} {o.currency}</td><td>{o.method === "card" ? "Card" : "Rail"}</td><td>{new Date(o.createdAt).toLocaleDateString()}</td><td className="text-right"><EvidenceButton poId={o.id} /></td></tr>)}</Table>}</Card>
  </div>;
}
