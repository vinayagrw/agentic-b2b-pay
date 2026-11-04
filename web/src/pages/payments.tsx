import { useMemo, useState } from "react";
import * as D from "@radix-ui/react-dialog";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, GitBranch, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { RAIL_LABEL, type Rail } from "@b2b/shared";
import { api, useAct, useGet } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Button, Card, DataTable, EmptyState, ErrorNote, Mono, Muted, Table } from "../components/ui";

export type RailRow = { rail: Rail; label: string; feeUsd: number; maxAmount: number; settleMinutes: number; configured: boolean; notConfiguredReason?: string; env: "sandbox" | "live"; address?: string };
export const railName = (r?: string | null) => (r ? RAIL_LABEL[r as Rail] ?? r : "");

function ProviderLink({ pi }: { pi: any }) {
  const href = pi.explorerUrl ?? pi.dashboardUrl; if (!href) return null;
  return <a className="inline-flex items-center gap-1 text-primary hover:underline" href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{pi.explorerUrl ? "Basescan" : "Stripe dashboard"}<ExternalLink size={12} /></a>;
}

/** Live payments table. SSE refreshes the query on every server change. */
export function PaymentsTable({ title = "Payments" }: { title?: string }) {
  const { data, error } = useGet<any[]>("/payments");
  const [open, setOpen] = useState<string | null>(null);
  const { run, busy, error: e2 } = useAct();
  const cols = useMemo<ColumnDef<any>[]>(() => [
    { header: "Payment", accessorKey: "id", cell: (c) => <span className="flex flex-col"><Mono>{c.getValue<any>()}</Mono>{c.row.original.kind === "refund" && <Muted>Refund of {c.row.original.linkedIntentId}</Muted>}</span> },
    { header: "Amount", accessorKey: "amount", cell: (c) => <span className="tabular-nums">{usd(c.getValue<any>())}</span> },
    { header: "Status", accessorKey: "status", cell: (c) => <Badge v={c.getValue<any>()} tone={c.getValue<any>() === "pending" || c.getValue<any>() === "submitted" ? "warn" : undefined} /> },
    { header: "Rail", id: "rail", accessorFn: (r) => r.rail ?? r.route?.rail ?? "", cell: (c) => <span className="flex items-center gap-1">{railName(c.getValue<any>())}{c.row.original.env && <Badge v={c.row.original.env === "live" ? "LIVE" : "TEST"} tone={c.row.original.env === "live" ? "bad" : "neutral"} />}</span> },
    { header: "Provider ref", accessorKey: "providerRef", cell: (c) => <Mono className="block max-w-[180px] truncate">{c.getValue<any>() ?? ""}</Mono> },
    { header: "Link", id: "link", enableSorting: false, cell: (c) => <ProviderLink pi={c.row.original} /> },
    { header: "Reason", accessorKey: "blockedReason", enableSorting: false, cell: (c) => <Muted className="block max-w-[240px] truncate">{c.getValue<any>() ?? ""}</Muted> },
  ], []);
  if (error) return <ErrorNote msg={(error as Error).message} />;
  return <Card title={title} pad={false} action={<Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => api("/payments/poll", {}))}><RefreshCw size={13} />Check status now</Button>}>
    <ErrorNote msg={e2} />
    <DataTable data={data ?? []} columns={cols} onRow={(r: any) => setOpen(r.id)} empty={<EmptyState title="No payments yet" body="Payments show here as soon as they are submitted, and update live as rails confirm them." />} />
    <PaymentDrawer id={open} onClose={() => setOpen(null)} />
  </Card>;
}

export function PaymentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = useGet<any>(`/payments/${id}`, !!id);
  const pi = data?.intent;
  return <D.Root open={!!id} onOpenChange={(o) => !o && onClose()}>
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/30" />
      <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-5 shadow-xl">
        <div className="flex items-center gap-2"><D.Title className="text-sm font-semibold">Payment {id}</D.Title><D.Close asChild><Button size="icon" variant="ghost" className="ml-auto" aria-label="Close"><X size={16} /></Button></D.Close></div>
        <D.Description className="sr-only">Payment detail and event timeline</D.Description>
        {!pi ? <Muted>Loading</Muted> : <>
          <Table>
            <tr><td className="text-muted">Status</td><td><Badge v={pi.status} /></td></tr>
            <tr><td className="text-muted">Amount</td><td className="tabular-nums">{usd(pi.amount)}</td></tr>
            <tr><td className="text-muted">Rail</td><td>{railName(pi.rail ?? pi.route?.rail)} {pi.env && <Badge v={pi.env === "live" ? "LIVE" : "TEST"} tone="neutral" />}</td></tr>
            <tr><td className="text-muted">Provider ref</td><td><Mono className="break-all">{pi.providerRef ?? "None yet"}</Mono></td></tr>
            <tr><td className="text-muted">Link</td><td><ProviderLink pi={pi} /></td></tr>
            <tr><td className="text-muted">Invoice</td><td><Mono>{pi.invoiceId}</Mono></td></tr>
            <tr><td className="text-muted">Idempotency key</td><td><Mono className="break-all">{pi.idempotencyKey}</Mono></td></tr>
          </Table>
          <Button asChild size="sm" variant="primary"><Link to={`${location.pathname.startsWith("/operator") ? "/operator" : "/app"}/payments/${pi.id}`}><GitBranch size={13} aria-hidden />Open transaction flow</Link></Button>
          {pi.blockedReason && <ErrorNote msg={pi.blockedReason} />}
          {pi.kind === "refund" && <Muted>Refund linked to payment {pi.linkedIntentId}</Muted>}
          {!!pi.refundIds?.length && <Muted>Refunds: {pi.refundIds.join(", ")}</Muted>}
          {pi.status === "settled" && pi.kind !== "refund" && <RefundBox pi={pi} />}
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Timeline</div>
          <ol className="relative ml-2 border-l border-border">
            {(pi.timeline ?? []).map((t: any, n: number) => <li key={n} className="mb-3 ml-4">
              <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-surface bg-primary" />
              <div className="flex items-center gap-2"><Badge v={t.status} /><Muted>{t.source} at {String(t.at).slice(11, 19)}</Muted></div>
              <div className="text-[13px]">{t.detail}</div>
            </li>)}
          </ol>
          <details><summary className="cursor-pointer text-xs text-muted">Audit records ({data.evidence.length})</summary>
            <ul className="mt-1 text-xs">{data.evidence.map((e: any) => <li key={e.id}><Mono>{e.event}</Mono> <Muted>{e.createdAt.slice(11, 19)}</Muted></li>)}</ul></details>
        </>}
      </D.Content>
    </D.Portal>
  </D.Root>;
}

/** Rail readiness strip. Rails without keys show Not configured and the router skips them. */
export function RailStatus() {
  const { data } = useGet<RailRow[]>("/rails");
  return <Card title="Rails" pad={false}>{data ? <Table head={["Rail", "Environment", "Status", "Fee on 1,000 USD"]}>{data.map((r) => <tr key={r.rail}>
    <td className="font-medium">{r.label}</td><td><Badge v={r.env === "live" ? "LIVE" : "TEST"} tone={r.env === "live" ? "bad" : "neutral"} /></td>
    <td>{r.configured ? <Badge v="Ready" tone="ok" /> : <span className="flex items-center gap-1"><Badge v="Not configured" tone="bad" /><Muted>{r.notConfiguredReason}</Muted></span>}{r.address && <div><Mono className="text-muted">{r.address}</Mono></div>}</td>
    <td className="tabular-nums">{usd(r.feeUsd)}</td></tr>)}</Table> : <Muted className="p-4">Loading</Muted>}</Card>;
}

/** Refunds go back on the same rail when the provider supports it. Stablecoin sends are final. */
function RefundBox({ pi }: { pi: any }) {
  const { run, busy, error } = useAct(); const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  return <div className="flex flex-col gap-2 rounded-lg bg-subtle p-3"><div className="text-xs font-medium">Refund</div>
    <div className="flex gap-2"><input className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-[13px]" type="number" min={0} aria-label="Refund amount" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} /><input className="h-8 flex-1 rounded-md border border-border bg-surface px-2 text-[13px]" aria-label="Refund reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button size="sm" disabled={busy || !Number(amount) || !reason} onClick={() => run(() => api("/refunds", { paymentIntentId: pi.id, amount: Number(amount), reason }))}>Refund</Button></div>
    <ErrorNote msg={error} /></div>;
}
