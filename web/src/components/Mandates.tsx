import { api, useAct, useAppState, useGet, useMe } from "../lib/api";
import { useNavigate } from "react-router-dom";
import { can } from "../lib/perm";
import { canIssueFromMandate } from "../lib/cards";
import { usd } from "../lib/utils";
import { useState } from "react";
import { CreditCard, Download, FileCheck2 } from "lucide-react";
import { Badge, Button, Card, EmptyState, ErrorNote, Mono, Muted } from "./ui";
import { Skeleton, SlidePanel, StatusDot } from "./kit";
import { downloadJson, eventText, evidenceFileName, orderIsPaid, paidLine, type Evidence } from "../lib/evidence";

type M = { id: string; kind: "intent" | "cart"; signerId: string; signerKind: "user" | "agent"; hash: string; createdAt: string; keyFingerprint: string | null; signatureValid: boolean; body: any };
type View = { poId: string; intent: M | null; cart: M | null; ok: boolean; reason: string; checks: { rule: string; pass: boolean; detail: string }[] };

function MandateBlock({ m, title }: { m: M; title: string }) {
  const b = m.body;
  const what = m.kind === "intent"
    ? `Up to ${usd(b.maxAmount)} ${b.currency} with ${b.supplierId} for ${b.category}, until ${new Date(b.expiresAt).toLocaleDateString()}`
    : `${b.lines.length} invoice lines, ${usd(b.amount)} ${b.currency} to ${b.supplierId}${b.railHint ? `, rail hint ${b.railHint}` : ""}`;
  return <div className="rounded-lg border border-border p-3 space-y-1.5">
    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{title}</span><StatusDot tone={m.signatureValid ? "ok" : "bad"} label={m.signatureValid ? "Signature valid" : "Signature invalid"} /></div>
    <div className="text-sm">{what}</div>
    <div><Muted>Signed by {m.signerKind === "user" ? "user" : "agent"} <Mono>{m.signerId}</Mono> on {new Date(m.createdAt).toLocaleString()}</Muted></div>
    <div className="text-xs text-muted break-all">Hash <Mono>{m.hash}</Mono></div>
    {m.keyFingerprint && <div className="text-xs text-muted">Key fingerprint <Mono>{m.keyFingerprint}</Mono></div>}
  </div>;
}

/** AP2 style Intent and Cart mandates for one payment, checked again on every load. */
export function MandatesCard({ id }: { id: string }) {
  const { data } = useGet<View>(`/payments/${id}/mandates`, !!id);
  const { data: st } = useAppState(); const { data: me } = useMe(); const { run, busy, error } = useAct(); const nav = useNavigate();
  if (!data) return <Card title="Signed mandates"><Skeleton lines={3} /></Card>;
  if (!data.intent && !data.cart) return <Card title="Signed mandates"><EmptyState title="No signed mandates" body="This purchase order was created before signed mandates were switched on, so it has no signed Intent or Cart and the payment is blocked. Raise a new purchase order or reset the demo data." /></Card>;
  const plain = data.ok ? "The user approved this purchase and the agent's cart fits inside that approval. The payment matches the cart exactly." : `This payment is held. ${data.reason}`;
  return <Card title="Signed mandates" action={<span className="flex items-center gap-2">{canIssueFromMandate(data.ok, st?.pos?.find((p: any) => p.id === data.poId)?.status) && can(me, "flow.operate") && <Button size="sm" disabled={busy} title="A card that works only for this order and its exact amount" onClick={async () => { const r = await run(() => api<{ card: { id: string } }>(`/orders/${data.poId}/card`, {})); if (r?.card) nav(`/app/cards/${r.card.id}`); }}><CreditCard size={13} aria-hidden />Issue card</Button>}{orderIsPaid(st as any, data.poId) && <EvidenceButton poId={data.poId} />}<Badge v={data.ok ? "valid" : "blocked"} tone={data.ok ? "ok" : "bad"} /></span>}>
    <ErrorNote msg={error} />
    <p className="text-sm mb-3">{plain}</p>
    <div className="grid gap-3 md:grid-cols-2">
      {data.intent && <MandateBlock m={data.intent} title="Intent, signed by the user" />}
      {data.cart && <MandateBlock m={data.cart} title="Cart, signed by the agent" />}
    </div>
    <ul className="mt-3 space-y-1">{data.checks.map((c) => <li key={c.rule} className="flex items-center justify-between gap-2"><StatusDot tone={c.pass ? "ok" : "bad"} label={c.rule} /><span className="text-xs text-muted">{c.detail}</span></li>)}</ul>
  </Card>;
}

const when = (s: string) => new Date(s).toLocaleString();
const Head = ({ children }: { children: React.ReactNode }) => <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">{children}</div>;

/** Opens the dispute evidence record for one paid order. */
export function EvidenceButton({ poId }: { poId: string }) {
  const [open, setOpen] = useState(false);
  return <><Button size="sm" onClick={() => setOpen(true)}><FileCheck2 size={13} aria-hidden />Evidence</Button>{open && <EvidenceDrawer poId={poId} onClose={() => setOpen(false)} />}</>;
}

/** Dispute evidence for one paid order: mandates, agent, approvals, card decision and audit events in time order. */
export function EvidenceDrawer({ poId, onClose }: { poId: string; onClose: () => void }) {
  const { data: e, error } = useGet<Evidence>(`/orders/${poId}/evidence`, !!poId);
  return <SlidePanel open onClose={onClose} width={560} title={`Evidence for order ${poId}`} description="One record for a dispute. It joins the signed mandates, the agent, the approvals, the card decision and the audit events."
    footer={<Button variant="primary" size="sm" disabled={!e} onClick={() => e && downloadJson(evidenceFileName(poId), e)}><Download size={13} aria-hidden />Download JSON</Button>}>
    {!e ? (error ? <ErrorNote msg={(error as any)?.message ?? "No evidence record for this order"} /> : <Skeleton lines={8} />) : <div data-testid="evidence">
      <p className="text-sm">{paidLine(e)}</p>
      <div className="mt-1"><Muted>{e.order.supplier}, {usd(e.order.total)} {e.order.currency}. Order raised {when(e.order.createdAt)}.</Muted></div>
      <div className="mt-2"><StatusDot tone={e.chain.valid ? "ok" : "bad"} label={e.chain.valid ? "Audit chain intact" : "Audit chain broken"} /></div>

      <Head>Signed mandates</Head>
      {!e.mandates.intent && !e.mandates.cart && <Muted>No signed mandates on this order.</Muted>}
      <div className="mt-1 space-y-2">
        {e.mandates.intent && <MandateBlock m={e.mandates.intent} title="Intent, signed by the user" />}
        {e.mandates.cart && <MandateBlock m={e.mandates.cart} title="Cart, signed by the agent" />}
        {!!e.mandates.history?.length && <div><Muted>Older mandates, replaced by the ones above</Muted>{e.mandates.history.map((m) => <MandateBlock key={m.id} m={m} title={`Old ${m.kind}, replaced ${m.supersededAt ? new Date(m.supersededAt).toLocaleString() : ""}`} />)}</div>}
      </div>

      <Head>Agent identity</Head>
      {e.agent ? <div className="mt-1 text-[13px]">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{e.agent.name}</span><Mono>{e.agent.id}</Mono><Badge v={e.agent.kyaStatus === "verified" ? "KYA verified" : "KYA not verified"} tone={e.agent.kyaStatus === "verified" ? "ok" : "bad"} /></div>
        {e.agent.keyFingerprint && <div><Muted>Key fingerprint <Mono>{e.agent.keyFingerprint}</Mono></Muted></div>}
        {e.agent.authority && <div><Muted>Acts for {e.agent.authority.principal}. Up to {usd(e.agent.authority.perTxnMax)} per order, approval needed from {usd(e.agent.authority.approvalThreshold)}.</Muted></div>}
      </div> : <Muted>The agent record is missing.</Muted>}

      <Head>Approvals</Head>
      {!e.approvals.decisions.length ? <div className="mt-1"><Muted>{e.approvals.needed ? "No approval is recorded." : `No person had to approve. Policy result: ${e.order.policy.outcome}.`}</Muted></div> :
        <ul className="mt-1 space-y-1 text-[13px]">{e.approvals.decisions.map((d, n) => <li key={n}><Badge v={d.decision} tone={d.decision === "approved" ? "ok" : "bad"} /> {d.name} <Muted>level {d.level}{d.role ? `, ${d.role.replace("_", " ")}` : ""}, {when(d.at)}</Muted>{d.comment && <div><Muted>"{d.comment}"</Muted></div>}</li>)}</ul>}
      {e.approvals.rule && <div><Muted>Rule: {e.approvals.rule}</Muted></div>}

      <Head>Card authorization</Head>
      {!e.payment.cards.length ? <div className="mt-1"><Muted>No card was used. {e.payment.railPayments.map((p) => `Payment ${p.id} is ${p.status}.`).join(" ")}</Muted></div> :
        e.payment.cards.map((c) => <div key={c.id} className="mt-1 rounded-lg border border-border p-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.kind}</span><Mono>•••• {c.last4}</Mono><Muted>{c.issuerLabel}</Muted></div>
          {!c.authorizations.length ? <Muted>No charge yet.</Muted> : <ul className="mt-2 space-y-1">{c.authorizations.map((a) => <li key={a.id}><Badge v={a.decision} tone={a.decision === "approved" ? "ok" : "bad"} /> {usd(a.amount)} {a.currency} at {a.merchant} <Muted>{when(a.at)}</Muted><div><Muted>{a.reason}</Muted></div></li>)}</ul>}
        </div>)}

      <Head>Audit events in time order ({e.timeline.length})</Head>
      <ol className="relative ml-2 mt-2 border-l border-border">{e.timeline.map((t) => <li key={t.seq} className="mb-2 ml-4">
        <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-surface bg-primary" />
        <div className="text-[13px]">{eventText(t.event)}</div>
        <Muted>{when(t.at)}, {t.subjectType} {t.subjectId}{t.actor ? `, by ${t.actor}` : ""}</Muted>
      </li>)}</ol>
    </div>}
  </SlidePanel>;
}
