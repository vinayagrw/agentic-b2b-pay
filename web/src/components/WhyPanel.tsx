import { Download } from "lucide-react";
import { useGet } from "../lib/api";
import { Badge, Button, Card, Mono, Muted } from "./ui";
import { Skeleton, StatusDot, type Tone } from "./kit";

type Item = { key: string; decision: string; outcome: "passed" | "failed" | "waiting" | "not reached"; why: string; drivers: string[]; decidedBy: { kind: string; id: string; name: string }; at: string | null; evidence: { id: string; seq: number; event: string; hash: string } | null };
type Why = { paymentId: string; headline: string; items: Item[]; chain: { valid: boolean; brokenAt: number | null; records: number } };
const tone: Record<Item["outcome"], Tone> = { passed: "ok", failed: "bad", waiting: "warn", "not reached": "neutral" };

/** Plain words reasons for every decision on a payment, built from the evidence chain. No model. */
export function WhyPanel({ id }: { id: string }) {
  const { data } = useGet<Why>(`/payments/${id}/why`, !!id);
  if (!data) return <Card title="Why"><Skeleton lines={4} /></Card>;
  return <Card title="Why" action={<div className="flex gap-2">
    <Button asChild size="sm" variant="outline"><a href={`/api/payments/${id}/why/export.json`} download><Download size={13} aria-hidden />JSON</a></Button>
    <Button asChild size="sm" variant="outline"><a href={`/api/payments/${id}/why/export.md`} download><Download size={13} aria-hidden />Report</a></Button>
  </div>}>
    <p className="text-sm font-medium mb-1">{data.headline}</p>
    <div className="mb-3"><StatusDot tone={data.chain.valid ? "ok" : "bad"} label={data.chain.valid ? `Evidence chain intact, ${data.chain.records} records checked` : `Evidence chain broken at record ${data.chain.brokenAt}`} /></div>
    <ol className="space-y-3">{data.items.map((i) => <li key={i.key} className="rounded-lg border border-border p-3 space-y-1">
      <div className="flex items-center justify-between gap-2"><StatusDot tone={tone[i.outcome]} label={<span className="font-medium">{i.decision}</span>} /><Badge v={i.outcome} tone={tone[i.outcome]} /></div>
      <p className="text-sm">{i.why}</p>
      {i.drivers.length > 0 && <ul className="text-xs text-muted list-disc pl-5">{i.drivers.map((d) => <li key={d}>{d}</li>)}</ul>}
      <Muted>Decided by {i.decidedBy.name} ({i.decidedBy.kind}){i.at ? ` on ${new Date(i.at).toLocaleString()}` : ""}</Muted>
      {i.evidence && <div className="text-xs text-muted break-all">Evidence {i.evidence.id} <Mono>{i.evidence.hash}</Mono></div>}
    </li>)}</ol>
  </Card>;
}
