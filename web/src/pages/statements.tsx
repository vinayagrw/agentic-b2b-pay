import { useState } from "react";
import { Upload } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can, noAccessText } from "../lib/perm";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Mono, Muted, PageHeader, Select, Table } from "../components/ui";
import { Section } from "../components/Shell";
import { Loading } from "./flows";

type Line = { id: string; amount: number; currency: string; direction: string; valueDate: string; endToEndId: string | null; bankRef: string | null; info: string | null; status: "unmatched" | "matched" | "ignored"; settlementId: string | null; resolution?: { action: string; note: string; by: string }; pendingChangeId?: string | null };
type Target = { settlementId: string; intentId: string; amount: number; currency: string; confirmedAt: string };
type View = { statements: { id: string; filename: string; format: string; statementId: string; lineCount: number; importedAt: string }[]; lines: Line[]; exceptions: Line[]; matched: number; targets: Target[] };

const q = (tenantId?: string) => (tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "");
const money = (n: number, c: string) => `${n.toFixed(2)} ${c}`;

function LineRow({ l, targets, tenantId, canEdit }: { l: Line; targets: Target[]; tenantId?: string; canEdit: boolean }) {
  const { run, busy, error } = useAct(); const [pick, setPick] = useState(""); const [note, setNote] = useState(""); const [over, setOver] = useState(false); const [sent, setSent] = useState(!!l.pendingChangeId);
  const ask = async (f: () => Promise<unknown>) => { if (await run(f)) setSent(true); };
  const base = `/reconciliation/statements/lines/${encodeURIComponent(l.id)}`;
  return <li className="px-4 py-3">
    <div className="flex flex-wrap items-center gap-2 text-[13px]"><Badge v="Unmatched" tone="bad" /><span className="tabular-nums">{money(l.amount, l.currency)} {l.direction}</span><Muted>value date {l.valueDate}</Muted><Mono>{l.endToEndId ?? "no reference"}</Mono><span className="flex-1">{l.info}</span></div>
    {sent && <div className="mt-2"><Badge v="Waiting for a second client admin to approve" tone="neutral" /></div>}
    {canEdit && !sent && <div className="mt-2 flex flex-wrap gap-2">
      <Select className="max-w-xs" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Pick a payment</option>{targets.map((t) => <option key={t.settlementId} value={t.settlementId}>{t.intentId} {money(t.amount, t.currency)} on {t.confirmedAt.slice(0, 10)}</option>)}</Select>
      <Input className="max-w-xs" placeholder="Note or reason" value={note} onChange={(e) => setNote(e.target.value)} />
      <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={over} onChange={(e) => setOver(e.target.checked)} />Amount differs, match anyway</label>
      <Button size="sm" disabled={busy || !pick} onClick={() => ask(() => api(`${base}/match${q(tenantId)}`, { settlementId: pick, note, override: over }))}>Match</Button>
      <Button size="sm" variant="ghost" disabled={busy || !note.trim()} onClick={() => ask(() => api(`${base}/ignore${q(tenantId)}`, { reason: note }))}>Ignore with reason</Button>
    </div>}
    <ErrorNote msg={error} /></li>;
}

/** Bank statement import and line matching. Operators pass tenantId, client admins leave it out. */
export function BankStatements({ tenantId }: { tenantId?: string }) {
  const { data: me } = useMe(); const canEdit = can(me, "statements.manage");
  const { data, error } = useGet<View>(`/reconciliation/statements${q(tenantId)}`);
  const { run, busy, error: upErr } = useAct(); const [msg, setMsg] = useState("");
  const upload = async (f: File | undefined) => {
    if (!f) return; const content = await f.text();
    const r = await run(() => api<any>(`/reconciliation/statements${q(tenantId)}`, { filename: f.name, content }));
    if (r) setMsg(`Imported ${r.lines} lines. ${r.matched} matched on their own.`);
  };
  if (!data) return <Loading error={error as Error} />;
  const done = data.lines.filter((l) => l.status !== "unmatched");
  return <>
    <Card title="Bank statements" action={canEdit ? <label className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium"><Upload size={13} />Upload camt.053 or MT940<input type="file" accept=".xml,.txt,.sta,.940" className="hidden" disabled={busy} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} /></label> : undefined}>
      <Muted>Lines match a settled payment when the amount, currency and reference agree and the value date is within 2 days. Sandbox files only.</Muted>
      {msg && <p className="mt-2 text-[13px]">{msg}</p>}<ErrorNote msg={upErr} />
      {data.statements.length ? <Table head={["Statement", "File", "Format", "Lines", "Imported"]}>{data.statements.map((s) => <tr key={s.id}><td><Mono>{s.statementId}</Mono></td><td>{s.filename}</td><td>{s.format}</td><td className="tabular-nums">{s.lineCount}</td><td>{s.importedAt.slice(0, 16).replace("T", " ")}</td></tr>)}</Table> : <EmptyState title="No statements yet" />}
    </Card>
    <Card title={`Unmatched statement lines (${data.exceptions.length})`} pad={false}>{data.exceptions.length ? <ul className="divide-y divide-border">{data.exceptions.map((l) => <LineRow key={l.id} l={l} targets={data.targets.filter((t) => t.currency === l.currency)} tenantId={tenantId} canEdit={canEdit} />)}</ul> : <EmptyState title="Every statement line is closed" />}</Card>
    {!!done.length && <Card title="Closed statement lines" pad={false}><Table head={["Amount", "Value date", "Reference", "Status", "Payment", "Note"]}>{done.map((l) => <tr key={l.id}><td className="tabular-nums">{money(l.amount, l.currency)}</td><td>{l.valueDate}</td><td><Mono>{l.endToEndId ?? "none"}</Mono></td><td><Badge v={l.status} tone={l.status === "matched" ? "ok" : "neutral"} /></td><td><Mono>{l.settlementId ?? ""}</Mono></td><td><Muted>{l.resolution?.note}</Muted></td></tr>)}</Table></Card>}
  </>;
}

export function ClientReconciliation() {
  const { data: me } = useMe();
  const head = <PageHeader title="Reconciliation" sub="Upload a bank statement to check each payment left the bank as expected." />;
  if (!me) return <Section>{head}<Loading /></Section>;
  if (!can(me, "statements.read")) return <Section>{head}<EmptyState title="No access" body={noAccessText("statements.read")} /></Section>;
  return <Section>{head}<BankStatements /></Section>;
}
