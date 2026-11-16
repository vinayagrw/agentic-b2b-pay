import { useState } from "react";
import { Download } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can } from "../lib/perm";
import { daysError, exportUrl, keepText, runSummary, TYPE_LABEL, verifyText, type Policy, type RetentionView, type VerifyResult } from "../lib/retention";
import { Badge, Button, ConfirmButton, Card, ErrorNote, Input, Label, Muted, PageHeader, Select, Table } from "../components/ui";
import { Section } from "../components/Shell";
import { SkeletonTable } from "../components/kit";

function PolicyRow({ p, edit }: { p: Policy; edit: boolean }) {
  const { run, busy, error } = useAct(); const [v, setV] = useState(p.days == null ? "" : String(p.days)); const bad = daysError(v);
  return <tr><td className="py-2">{TYPE_LABEL[p.recordType]}</td><td>{keepText(p.days)}</td>
    <td>{edit ? <div className="flex items-center gap-2"><Input aria-label={`Days to keep ${TYPE_LABEL[p.recordType]}`} className="w-28" inputMode="numeric" placeholder="Forever" value={v} onChange={(e) => setV(e.target.value)} />
      <Button size="sm" disabled={busy || !!bad} onClick={() => run(() => api(`/ops/retention/policies/${p.recordType}`, { days: v.trim() === "" ? null : Number(v) }, { method: "PUT" }))}>Save</Button></div> : <Muted>View only</Muted>}
      {bad && <p className="text-xs text-bad" role="alert">{bad}</p>}<ErrorNote msg={error} /></td></tr>;
}

function HoldForm({ tenants }: { tenants: { id: string; name: string; kind: string }[] }) {
  const { run, busy, error } = useAct(); const clients = tenants.filter((t) => t.kind === "client");
  const [tenantId, setT] = useState(clients[0]?.id ?? ""); const [caseId, setC] = useState(""); const [reason, setR] = useState("");
  return <div className="grid gap-3 sm:grid-cols-4">
    <div className="flex flex-col gap-1"><Label>Client</Label><Select aria-label="Hold client" value={tenantId} onChange={(e) => setT(e.target.value)}>{clients.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></div>
    <div className="flex flex-col gap-1"><Label>Case (optional)</Label><Input aria-label="Hold case" placeholder="case-1234" value={caseId} onChange={(e) => setC(e.target.value)} /></div>
    <div className="flex flex-col gap-1"><Label>Reason</Label><Input aria-label="Hold reason" value={reason} onChange={(e) => setR(e.target.value)} placeholder="Court order" /></div>
    <div className="flex items-end"><Button variant="primary" disabled={busy || reason.trim().length < 3} onClick={async () => { const r = await run(() => api("/ops/retention/holds", { tenantId, caseId: caseId.trim() || undefined, reason })); if (r) { setR(""); setC(""); } }}>Place hold</Button></div>
    <div className="sm:col-span-4"><ErrorNote msg={error} /></div>
  </div>;
}

export function RetentionPage() {
  const { data: v, isLoading, error } = useGet<RetentionView>("/ops/retention"); const { data: me } = useMe();
  const { data: tenants } = useGet<any[]>("/tenants");
  const edit = can(me, "retention.manage");
  const purge = useAct(); const release = useAct(); const check = useAct(); const [ver, setVer] = useState<VerifyResult | null>(null);
  const clients = (tenants ?? []).filter((t) => t.kind === "client");
  const [exT, setExT] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const exportTenant = exT || clients[0]?.id || "";
  return <Section>
    <PageHeader title="Data retention" sub="Choose how long to keep each kind of record. A legal hold stops a purge for a client or a case." />
    {v && <Muted>{v.mode}</Muted>}
    {error ? <ErrorNote msg={(error as Error).message} /> : isLoading || !v ? <Card pad={false}><SkeletonTable rows={4} cols={3} /></Card> : <>
      <Card title="Retention rules" pad={false}><div className="overflow-x-auto"><Table head={["Record", "Rule", "Days to keep"]}>{v.policies.map((p) => <PolicyRow key={`${p.recordType}-${p.updatedAt}`} p={p} edit={edit} />)}</Table></div></Card>
      <Card title="Legal holds">
        {edit && tenants && <HoldForm tenants={tenants} />}
        <ErrorNote msg={release.error} />
        <div className="mt-3 overflow-x-auto"><Table head={["Client", "Case", "Reason", "State", ""]}>{v.holds.map((h) => <tr key={h.id}><td className="py-2">{h.tenantId}</td><td>{h.caseId ?? "Whole client"}</td><td>{h.reason}</td>
          <td><Badge v={h.releasedAt ? "Released" : "On hold"} tone={h.releasedAt ? "neutral" : "warn"} /></td>
          <td>{edit && !h.releasedAt && <Button size="sm" variant="ghost" disabled={release.busy} onClick={() => release.run(() => api(`/ops/retention/holds/${h.id}/release`, {}))}>Release</Button>}</td></tr>)}</Table>
          {!v.holds.length && <Muted>No holds yet.</Muted>}</div>
      </Card>
      <Card title="Purge" action={edit ? <ConfirmButton variant="primary" size="sm" disabled={purge.busy} question="Remove every record older than its rule? Held records stay. This cannot be undone." onConfirm={() => void purge.run(() => api("/ops/retention/purge", {}))}>Run purge now</ConfirmButton> : undefined}>
        <ErrorNote msg={purge.error} />
        {v.anchor && <Muted>Audit links up to {v.anchor.seq} were purged on {v.anchor.at.slice(0, 10)}. Checks start from there.</Muted>}
        <ul className="mt-2 space-y-1 text-sm">{v.runs.map((r) => <li key={r.id}><span className="font-mono text-xs">{r.ranAt.slice(0, 16).replace("T", " ")}</span> {runSummary(r)} <Muted>by {r.ranBy}</Muted></li>)}</ul>
        {!v.runs.length && <Muted>No purge has run yet.</Muted>}
      </Card>
      <Card title="Audit chain">
        <div className="flex flex-wrap items-end gap-3">
          <Button size="sm" disabled={check.busy} onClick={async () => { const r = await check.run(() => api<VerifyResult>("/ops/audit/verify")); if (r) setVer(r); }}>Check the chain</Button>
          {ver && <span role="status" className={ver.valid ? "text-ok text-sm" : "text-bad text-sm"}>{verifyText(ver)}</span>}
        </div>
        <ErrorNote msg={check.error} />
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1"><Label>Client</Label><Select aria-label="Export client" value={exportTenant} onChange={(e) => setExT(e.target.value)}>{clients.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></div>
          <div className="flex flex-col gap-1"><Label>From</Label><Input aria-label="Export from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="flex flex-col gap-1"><Label>To</Label><Input aria-label="Export to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="flex items-end"><Button size="sm" variant="outline" asChild><a href={exportUrl(exportTenant, from, to)} download><Download size={13} aria-hidden />Export JSONL</a></Button></div>
        </div>
      </Card>
    </>}
  </Section>;
}
