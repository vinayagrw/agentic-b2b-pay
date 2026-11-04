import { useGet } from "../lib/api";
import { usd } from "../lib/utils";
import { Badge, Card, EmptyState, Mono, Muted } from "./ui";
import { Skeleton, StatusDot } from "./kit";

type M = { id: string; kind: "intent" | "cart"; signerId: string; signerKind: "user" | "agent"; hash: string; createdAt: string; keyFingerprint: string | null; signatureValid: boolean; body: any };
type View = { intent: M | null; cart: M | null; ok: boolean; reason: string; checks: { rule: string; pass: boolean; detail: string }[] };

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
  if (!data) return <Card title="Signed mandates"><Skeleton lines={3} /></Card>;
  if (!data.intent && !data.cart) return <Card title="Signed mandates"><EmptyState title="No signed mandates" body="This purchase was created before signed mandates existed, so the payment cannot be sent." /></Card>;
  const plain = data.ok ? "The user approved this purchase and the agent's cart fits inside that approval. The payment matches the cart exactly." : `This payment is held. ${data.reason}`;
  return <Card title="Signed mandates" action={<Badge v={data.ok ? "valid" : "blocked"} tone={data.ok ? "ok" : "bad"} />}>
    <p className="text-sm mb-3">{plain}</p>
    <div className="grid gap-3 md:grid-cols-2">
      {data.intent && <MandateBlock m={data.intent} title="Intent, signed by the user" />}
      {data.cart && <MandateBlock m={data.cart} title="Cart, signed by the agent" />}
    </div>
    <ul className="mt-3 space-y-1">{data.checks.map((c) => <li key={c.rule} className="flex items-center justify-between gap-2"><StatusDot tone={c.pass ? "ok" : "bad"} label={c.rule} /><span className="text-xs text-muted">{c.detail}</span></li>)}</ul>
  </Card>;
}
