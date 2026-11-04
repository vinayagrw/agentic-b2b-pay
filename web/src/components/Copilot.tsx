import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bot, Camera, Database, Download, Gift, History, Mic, MicOff, Pencil, Plus, RotateCcw, Search, Send, Square, ShieldAlert, Sun, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { api, useAct } from "../lib/api";
import { useStream } from "../lib/stream";
import { foldStream, recordFromPath, snapProblem, speechCtor, SNAP_TYPES, TOOL_NAMES, type Answer, type Chart, type Offer, type Proposal, type Thread } from "../lib/copilot";
import { SlidePanel } from "./kit";
import { BarList, DataTable, DonutChart } from "./live";
import { Badge, Button, Input } from "./ui";

const EVENTS = ["status", "tool", "token", "done", "failed"];
const DIGEST = "What changed today?";
const num = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(Math.round(n * 100) / 100));

/** Copilot chat in a slide panel. It knows the page you are on, keeps threads on the server, and only proposes actions that need your click. */
export function CopilotPanel({ open, onClose, seed }: { open: boolean; onClose: () => void; seed?: string }) {
  const loc = useLocation(); const route = loc.pathname; const recordId = recordFromPath(route);
  const [q, setQ] = useState(""); const [url, setUrl] = useState<string | null>(null);
  const [asked, setAsked] = useState(""); const [history, setHistory] = useState<Answer[]>([]); const [err, setErr] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null); const [view, setView] = useState<"chat" | "threads">("chat");
  const [suggest, setSuggest] = useState<string[]>([]); const [snaps, setSnaps] = useState<any[]>([]); const [voice, setVoice] = useState(false);
  const stream = useStream<any>(url, EVENTS, { max: 2000 });
  const f = foldStream(stream.messages);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    api<{ questions: string[] }>(`/copilot/suggest?route=${encodeURIComponent(route)}&recordId=${encodeURIComponent(recordId ?? "")}`).then((r) => setSuggest(r.questions)).catch(() => setSuggest([]));
  }, [open, route, recordId]);
  const ask = async (text: string, replace = false) => {
    const t = text.trim(); if (!t || url) return;
    if (replace) setHistory((h) => h.slice(0, -1));
    setErr(""); setQ(""); setVoice(false); setAsked(t); setView("chat"); stream.clear();
    try { const { id } = await api<{ id: string }>("/copilot/ask", { question: t, threadId, route, recordId, voice }); setUrl(`/api/copilot/stream/${id}`); } catch (e: any) { setErr(e.message); setAsked(""); }
  };
  useEffect(() => { if (open && seed) ask(seed); }, [open, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (f.done) { setHistory((h) => [...h, f.done!]); setThreadId(f.done.threadId); setUrl(null); setAsked(""); stream.clear(); }
    else if (f.failed) { setErr(f.failed); setUrl(null); setAsked(""); stream.clear(); }
  }, [f.done, f.failed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [history.length, f.text]);
  const openThread = async (id: string) => { try { const t = await api<Thread>(`/copilot/threads/${id}`); setHistory(t.answers ?? []); setThreadId(t.id); setView("chat"); } catch (e: any) { setErr(e.message); } };
  const stop = () => { setUrl(null); if (asked) setQ(asked); setAsked(""); stream.clear(); };
  const last = history[history.length - 1];
  const edit = () => { if (!last) return; setQ(last.question); setHistory((h) => h.slice(0, -1)); };
  const fresh = () => { setHistory([]); setThreadId(null); setView("chat"); setErr(""); };
  return <SlidePanel open={open} onClose={onClose} width={560} title={<span className="flex items-center gap-2"><Bot size={15} aria-hidden />Copilot</span>} description={recordId ? `Looking at ${recordId}` : "Ask about spend, payments, suppliers, approvals, ledger and FX"}
    footer={<form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
      <SnapButton disabled={!!url} onDraft={(d) => setSnaps((x) => [...x, d])} onError={setErr} />
      <MicButton disabled={!!url} onText={(t) => { setQ(t); setVoice(true); }} />
      <Input aria-label="Ask the copilot" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setVoice(false); }} placeholder={recordId ? `Ask about ${recordId} or anything else` : "Ask about spend, approvals, ledger or FX"} disabled={!!url} className="flex-1" />
      {url ? <Button type="button" variant="outline" onClick={stop} aria-label="Stop answer" title="Stop"><Square size={14} /></Button> : <Button type="submit" variant="primary" disabled={!q.trim()} aria-label="Send question"><Send size={14} /></Button>}</form>}>
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant={view === "chat" ? "primary" : "outline"} onClick={() => setView("chat")}>Chat</Button>
      <Button size="sm" variant={view === "threads" ? "primary" : "outline"} onClick={() => setView("threads")}><History size={13} aria-hidden className="mr-1" />Threads</Button>
      <Button size="sm" onClick={fresh}><Plus size={13} aria-hidden className="mr-1" />New</Button>
      <Button size="sm" onClick={() => ask(DIGEST)} disabled={!!url}><Sun size={13} aria-hidden className="mr-1" />What changed today</Button>
    </div>
    {view === "threads" ? <Threads current={threadId} onOpen={openThread} onDeleted={(id) => { if (id === threadId) fresh(); }} /> : <>
      <p className="text-xs text-muted">Answers use read-only tools on your tenant only. The copilot can suggest an action, but nothing happens until you click it, and the normal permission and approval checks still apply.</p>
      {!history.length && !asked && <div className="flex flex-col gap-1.5" aria-label="Suggested questions">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Suggested for this page</span>
        <div className="flex flex-wrap gap-1.5">{suggest.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-border px-2.5 py-1 text-left text-xs hover:bg-subtle">{s}</button>)}</div></div>}
      {history.map((a) => <Turn key={a.id} a={a} onClose={onClose} />)}
      {last && !url && <div className="flex justify-end gap-1.5"><Button size="sm" variant="outline" onClick={edit}><Pencil size={13} aria-hidden className="mr-1" />Edit question</Button><Button size="sm" variant="outline" onClick={() => ask(last.question, true)}><RotateCcw size={13} aria-hidden className="mr-1" />Regenerate</Button></div>}
      {snaps.map((d) => <SnapCard key={d.id} d={d} />)}
      {asked && <div className="flex flex-col gap-2" aria-live="polite">
        <Bubble me>{asked}</Bubble>
        <div className="flex flex-wrap gap-1">{f.tools.map((t, n) => <Badge key={n} v={`${TOOL_NAMES[t.tool] ?? t.tool}${t.error ? " failed" : ` ${t.rows} rows`}`} tone={t.error ? "bad" : "neutral"} />)}</div>
        <Bubble>{f.text || <span className="text-muted">{f.step === "writing" ? "Writing the answer" : "Reading your data"}</span>}</Bubble>
      </div>}
    </>}
    {err && <p role="alert" className="text-xs text-bad">{err}</p>}
    <div ref={end} />
  </SlidePanel>;
}

const Bubble = ({ me, children }: { me?: boolean; children: React.ReactNode }) => <div className={me ? "self-end rounded-xl bg-primary px-3 py-2 text-[13px] text-primary-fg" : "rounded-xl bg-subtle px-3 py-2 text-[13px] leading-relaxed"}>{children}</div>;

/** Saved threads with search, rename and delete. */
function Threads({ current, onOpen, onDeleted }: { current: string | null; onOpen: (id: string) => void; onDeleted: (id: string) => void }) {
  const [term, setTerm] = useState(""); const [rows, setRows] = useState<Thread[] | null>(null); const [edit, setEdit] = useState<{ id: string; title: string } | null>(null); const [err, setErr] = useState("");
  const load = () => api<Thread[]>(`/copilot/threads${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ""}`).then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [term]); // eslint-disable-line react-hooks/exhaustive-deps
  const rename = async () => { if (!edit) return; try { await api(`/copilot/threads/${edit.id}`, { title: edit.title }); setEdit(null); load(); } catch (e: any) { setErr(e.message); } };
  const del = async (id: string) => { try { await api(`/copilot/threads/${id}`, undefined, { method: "DELETE" }); onDeleted(id); load(); } catch (e: any) { setErr(e.message); } };
  return <div className="flex flex-col gap-2">
    <label className="flex items-center gap-2 rounded-md border border-border px-2"><Search size={13} aria-hidden className="text-muted" /><input aria-label="Search threads" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search threads" className="h-8 flex-1 bg-transparent text-[13px] outline-none" /></label>
    {err && <p role="alert" className="text-xs text-bad">{err}</p>}
    {!rows ? <p className="text-xs text-muted">Loading threads</p> : !rows.length ? <p className="text-xs text-muted">{term ? "No thread matches." : "No saved threads yet. Ask a question to start one."}</p> :
      <ul className="divide-y divide-border rounded-lg border border-border">{rows.map((t) => <li key={t.id} className="flex items-center gap-1.5 px-2.5 py-2">
        {edit?.id === t.id ? <form className="flex flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); rename(); }}><Input aria-label="Thread name" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} className="h-7 flex-1" autoFocus /><Button size="sm" type="submit" variant="primary">Save</Button><Button size="sm" type="button" onClick={() => setEdit(null)}>Cancel</Button></form> : <>
          <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(t.id)}><span className={`block truncate text-[13px] ${t.id === current ? "font-semibold" : ""}`}>{t.title}</span><span className="text-[11px] text-muted">{new Date(t.updatedAt).toLocaleString()}</span></button>
          <button aria-label={`Rename ${t.title}`} className="rounded p-1 text-muted hover:bg-subtle" onClick={() => setEdit({ id: t.id, title: t.title })}><Pencil size={13} /></button>
          <button aria-label={`Delete ${t.title}`} className="rounded p-1 text-muted hover:bg-subtle hover:text-bad" onClick={() => del(t.id)}><Trash2 size={13} /></button></>}
      </li>)}</ul>}
  </div>;
}

/** Inline chart for numeric answers, with a CSV of the answer data. */
function ChartView({ c, id }: { c: Chart; id: string }) {
  return <div className="rounded-lg border border-border p-2.5" aria-label={`${c.title} chart`}>
    <div className="mb-1.5 flex items-center justify-between text-xs font-medium"><span>{c.title}</span>
      <a href={`/api/copilot/answers/${id}/export.csv`} download className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"><Download size={12} aria-hidden />CSV</a></div>
    {c.kind === "donut" ? <DonutChart title={c.title} data={c.series} format={num} /> : c.kind === "bar" ? <BarList title={c.title} data={c.series} format={num} /> : <DataTable columns={c.columns} rows={c.rows} />}
  </div>;
}

function Vote({ a }: { a: Answer }) {
  const [v, setV] = useState(a.vote ?? null); const [err, setErr] = useState("");
  const send = async (vote: "up" | "down") => { try { await api("/copilot/feedback", { answerId: a.id, vote }); setV(vote); setErr(""); } catch (e: any) { setErr(e.message); } };
  return <span className="inline-flex items-center gap-1">
    <button aria-label="Good answer" aria-pressed={v === "up"} onClick={() => send("up")} className={`rounded p-1 hover:bg-subtle ${v === "up" ? "text-ok" : "text-muted"}`}><ThumbsUp size={13} /></button>
    <button aria-label="Bad answer" aria-pressed={v === "down"} onClick={() => send("down")} className={`rounded p-1 hover:bg-subtle ${v === "down" ? "text-bad" : "text-muted"}`}><ThumbsDown size={13} /></button>
    {err && <span role="alert" className="text-[11px] text-bad">{err}</span>}
  </span>;
}

function Turn({ a, onClose }: { a: Answer; onClose: () => void }) {
  return <div className="flex flex-col gap-2">
    <Bubble me>{a.question}</Bubble>
    <Bubble>{a.refused && <span className="mb-1 block text-[11px] font-medium text-warn">No source found, so no answer</span>}{a.answer}</Bubble>
    {a.chart && <ChartView c={a.chart} id={a.id} />}
    {a.proposals.map((p) => <ProposalCard key={p.id} p={p} answerId={a.id} />)}
    {(a.offers ?? []).map((o) => <OfferCard key={o.id} o={o} />)}
    {!!a.sources.length && <div className="rounded-lg border border-border p-2.5 text-xs" aria-label="Sources">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-muted"><Database size={12} aria-hidden />Sources{a.mode === "live" ? " (live model)" : " (mock mode)"}{a.fallback ? ", fell back to rules" : ""}</div>
      <ul className="flex flex-col gap-1">{a.sources.map((s) => <li key={s.tool}><span className="font-medium">{TOOL_NAMES[s.tool] ?? s.tool}</span>{s.links.length ? ": " : ", no records"}
        {s.links.slice(0, 8).map((l, n) => <span key={l.id + n}>{n > 0 && " "}<Link to={l.href} onClick={onClose} className="font-mono text-primary underline-offset-2 hover:underline">{l.id}</Link></span>)}</li>)}</ul>
    </div>}
    <div className="flex justify-end"><Vote a={a} /></div>
  </div>;
}

/** A proposed action. It runs only on click, through the normal API with your own permissions. */
function ProposalCard({ p, answerId }: { p: Proposal; answerId: string }) {
  const act = useAct(); const [done, setDone] = useState("");
  const run = async () => { const r = await act.run(() => api(p.path, p.body)); api("/copilot/outcome", { answerId, kind: p.kind, ok: !!r }).catch(() => undefined); if (r) setDone(p.path === "/changes" ? "Sent for review" : "Done. The normal API accepted it."); };
  return <div className="rounded-lg border border-warn/50 bg-warn/5 p-3 text-[13px]" role="group" aria-label="Proposed action">
    <div className="flex items-center gap-1.5 text-xs font-medium text-warn"><ShieldAlert size={13} aria-hidden />Proposed action, not done yet</div>
    <div className="mt-1 font-medium">{p.label}</div>
    {p.detail && <div className="mt-0.5 text-xs">{p.detail}</div>}
    <div className="mt-0.5 text-xs text-muted">{p.reason}</div>
    <div className="mt-2 flex items-center gap-2">
      {done ? <Badge v={done} tone="ok" /> : <Button size="sm" variant={/reject|hold|suspend/.test(p.kind) ? "danger" : "primary"} disabled={!p.allowed || act.busy} onClick={run}>{act.busy ? "Working" : p.allowed ? "Confirm and run" : "Not allowed for you"}</Button>}
      {act.error && <span role="alert" className="text-xs text-bad">{act.error}</span>}
    </div>
  </div>;
}

/** A bank product offer. Labelled, triggered by the tenant's own data, and never an action. */
function OfferCard({ o }: { o: Offer }) {
  return <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-[13px]" role="note" aria-label="Offer">
    <div className="flex items-center gap-1.5 text-xs font-medium text-primary"><Gift size={13} aria-hidden /><Badge v="Offer" tone="primary" />{o.title}</div>
    <div className="mt-1 text-xs">{o.body}</div><div className="mt-0.5 text-[11px] text-muted">Why you see this: {o.trigger}</div>
  </div>;
}

/** Snap to draft: a photo or PDF of an invoice or remittance becomes a draft for review. */
function SnapButton({ disabled, onDraft, onError }: { disabled: boolean; onDraft: (d: any) => void; onError: (e: string) => void }) {
  const ref = useRef<HTMLInputElement>(null); const [busy, setBusy] = useState(false);
  const pick = async (f?: File) => {
    if (!f) return; const bad = snapProblem(f); if (bad) { onError(bad); return; }
    setBusy(true); onError("");
    try { const b64 = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(new Error("Could not read the file")); r.readAsDataURL(f); });
      onDraft(await api("/copilot/snap", { filename: f.name, mime: f.type, dataBase64: b64 })); } catch (e: any) { onError(e.message); } finally { setBusy(false); if (ref.current) ref.current.value = ""; }
  };
  return <><input ref={ref} type="file" accept={SNAP_TYPES.join(",")} className="hidden" aria-label="Upload invoice or remittance" data-testid="snap-input" onChange={(e) => pick(e.target.files?.[0])} />
    <Button type="button" variant="outline" disabled={disabled || busy} aria-label="Snap an invoice or remittance" title="Snap an invoice or remittance" onClick={() => ref.current?.click()}><Camera size={14} /></Button></>;
}
function SnapCard({ d }: { d: any }) {
  const act = useAct(); const [sent, setSent] = useState<any>(null); const f = d.fields;
  return <div className="rounded-lg border border-border p-3 text-[13px]" role="group" aria-label="Snapped draft">
    <div className="flex items-center gap-1.5 text-xs font-medium"><Camera size={13} aria-hidden />Draft {f.kind} from {d.filename}<Badge v={d.source === "llm" ? "read by model" : "fixture parse"} tone="neutral" /></div>
    <table className="mt-1.5 w-full text-xs"><tbody>
      <tr><td className="text-muted">Supplier</td><td>{f.supplier}{d.supplierId ? ` (${d.supplierId})` : ", not matched"}</td></tr>
      <tr><td className="text-muted">Amount</td><td>{f.amount.toFixed(2)} {f.currency}</td></tr><tr><td className="text-muted">Date</td><td>{f.date}</td></tr>
      <tr><td className="text-muted">Lines</td><td>{f.lines.map((l: any) => `${l.qty} x ${l.sku || l.description} at ${l.unitPrice}`).join(", ") || "none"}</td></tr>
      <tr><td className="text-muted">Order</td><td>{d.poId ?? "No open order matches"}</td></tr></tbody></table>
    <div className="mt-1 text-[11px] text-muted">This is a draft for review, never a payment. Sending it creates an invoice that is three way matched, and paying it still needs the normal approvals.</div>
    <div className="mt-2 flex items-center gap-2">{sent ? <Badge v={`Invoice ${sent.invoice.id} ${sent.match?.status ?? ""}`} tone="ok" /> :
      f.kind === "invoice" && <Button size="sm" variant="primary" disabled={!d.poId || act.busy} onClick={async () => { const r = await act.run(() => api(`/copilot/snap/${d.id}/submit`, {})); if (r) setSent(r); }}>Send to invoices for match</Button>}
      {act.error && <span role="alert" className="text-xs text-bad">{act.error}</span>}</div>
  </div>;
}

/** Voice questions with the browser Web Speech API. Hidden when the browser has none. The text lands in the box for you to read before sending. */
function MicButton({ disabled, onText }: { disabled: boolean; onText: (t: string) => void }) {
  const [on, setOn] = useState(false); const rec = useRef<any>(null); const Ctor = speechCtor();
  if (!Ctor) return null;
  const toggle = () => {
    if (on) { rec.current?.stop(); return; }
    const r = new Ctor(); r.lang = navigator.language || "en-US"; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e: any) => onText(Array.from(e.results).map((x: any) => x[0].transcript).join(" "));
    r.onend = () => setOn(false); r.onerror = () => setOn(false); rec.current = r; r.start(); setOn(true);
  };
  return <Button type="button" variant={on ? "primary" : "outline"} disabled={disabled} aria-pressed={on} aria-label={on ? "Stop listening" : "Ask by voice"} title="Ask by voice, read-only questions" onClick={toggle}>{on ? <MicOff size={14} /> : <Mic size={14} />}</Button>;
}
