import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Database, ShieldAlert, Send } from "lucide-react";
import { api, useAct } from "../lib/api";
import { useStream } from "../lib/stream";
import { foldStream, TOOL_NAMES, type Answer, type Proposal } from "../lib/copilot";
import { SlidePanel } from "./kit";
import { Badge, Button, Input } from "./ui";

const SUGGEST = ["Who are our top suppliers by spend?", "What is waiting for approval?", "Show payments by status", "What are our entity balances?", "What is our FX exposure?"];
const EVENTS = ["status", "tool", "token", "done", "failed"];

/** Copilot chat in a slide panel. Answers come from read-only tools. Actions are proposal cards that need your click. */
export function CopilotPanel({ open, onClose, seed }: { open: boolean; onClose: () => void; seed?: string }) {
  const [q, setQ] = useState(""); const [url, setUrl] = useState<string | null>(null);
  const [asked, setAsked] = useState(""); const [history, setHistory] = useState<Answer[]>([]); const [err, setErr] = useState("");
  const stream = useStream<any>(url, EVENTS, { max: 2000 });
  const f = foldStream(stream.messages);
  const end = useRef<HTMLDivElement>(null);
  const ask = async (text: string) => {
    const t = text.trim(); if (!t || url) return;
    setErr(""); setQ(""); setAsked(t); stream.clear();
    try { const { id } = await api<{ id: string }>("/copilot/ask", { question: t }); setUrl(`/api/copilot/stream/${id}`); } catch (e: any) { setErr(e.message); setAsked(""); }
  };
  useEffect(() => { if (open && seed) ask(seed); }, [open, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (f.done) { setHistory((h) => [...h, f.done!]); setUrl(null); setAsked(""); stream.clear(); }
    else if (f.failed) { setErr(f.failed); setUrl(null); setAsked(""); stream.clear(); }
  }, [f.done, f.failed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [history.length, f.text]);
  return <SlidePanel open={open} onClose={onClose} width={520} title={<span className="flex items-center gap-2"><Bot size={15} aria-hidden />Copilot</span>} description="Ask about spend, payments, suppliers, approvals, ledger and FX"
    footer={<form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
      <Input aria-label="Ask the copilot" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about spend, approvals, ledger or FX" disabled={!!url} className="flex-1" />
      <Button type="submit" variant="primary" disabled={!!url || !q.trim()} aria-label="Send question"><Send size={14} /></Button></form>}>
    <p className="text-xs text-muted">Answers use read-only tools on your tenant only. The copilot can suggest an action, but nothing happens until you click it, and the normal permission and approval checks still apply.</p>
    {!history.length && !asked && <div className="flex flex-wrap gap-1.5">{SUGGEST.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-subtle">{s}</button>)}</div>}
    {history.map((a, n) => <Turn key={n} a={a} onClose={onClose} />)}
    {asked && <div className="flex flex-col gap-2" aria-live="polite">
      <Bubble me>{asked}</Bubble>
      <div className="flex flex-wrap gap-1">{f.tools.map((t, n) => <Badge key={n} v={`${TOOL_NAMES[t.tool] ?? t.tool}${t.error ? " failed" : ` ${t.rows} rows`}`} tone={t.error ? "bad" : "neutral"} />)}</div>
      <Bubble>{f.text || <span className="text-muted">{f.step === "writing" ? "Writing the answer" : "Reading your data"}</span>}</Bubble>
    </div>}
    {err && <p role="alert" className="text-xs text-bad">{err}</p>}
    <div ref={end} />
  </SlidePanel>;
}

const Bubble = ({ me, children }: { me?: boolean; children: React.ReactNode }) => <div className={me ? "self-end rounded-xl bg-primary px-3 py-2 text-[13px] text-primary-fg" : "rounded-xl bg-subtle px-3 py-2 text-[13px] leading-relaxed"}>{children}</div>;

function Turn({ a, onClose }: { a: Answer; onClose: () => void }) {
  return <div className="flex flex-col gap-2">
    <Bubble me>{a.question}</Bubble>
    <Bubble>{a.answer}</Bubble>
    {a.proposals.map((p) => <ProposalCard key={p.id} p={p} />)}
    {!!a.sources.length && <div className="rounded-lg border border-border p-2.5 text-xs" aria-label="Sources">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-muted"><Database size={12} aria-hidden />Sources{a.mode === "live" ? " (live model)" : " (mock mode)"}{a.fallback ? ", fell back to rules" : ""}</div>
      <ul className="flex flex-col gap-1">{a.sources.map((s) => <li key={s.tool}><span className="font-medium">{TOOL_NAMES[s.tool] ?? s.tool}</span>{s.links.length ? ": " : ", no records"}
        {s.links.slice(0, 8).map((l, n) => <span key={l.id + n}>{n > 0 && " "}<Link to={l.href} onClick={onClose} className="font-mono text-primary underline-offset-2 hover:underline">{l.id}</Link></span>)}</li>)}</ul>
    </div>}
  </div>;
}

/** A proposed action. It runs only on click, through the normal API with your own permissions. */
function ProposalCard({ p }: { p: Proposal }) {
  const act = useAct(); const [done, setDone] = useState("");
  const run = async () => { const r = await act.run(() => api(p.path, p.body)); if (r) setDone("Done. The normal API accepted it."); };
  return <div className="rounded-lg border border-warn/50 bg-warn/5 p-3 text-[13px]" role="group" aria-label="Proposed action">
    <div className="flex items-center gap-1.5 text-xs font-medium text-warn"><ShieldAlert size={13} aria-hidden />Proposed action, not done yet</div>
    <div className="mt-1 font-medium">{p.label}</div>
    <div className="mt-0.5 text-xs text-muted">{p.reason}</div>
    <div className="mt-2 flex items-center gap-2">
      {done ? <Badge v={done} tone="ok" /> : <Button size="sm" variant={p.kind === "reject_po" ? "danger" : "primary"} disabled={!p.allowed || act.busy} onClick={run}>{act.busy ? "Working" : p.allowed ? "Confirm and run" : "Not allowed for you"}</Button>}
      {act.error && <span role="alert" className="text-xs text-bad">{act.error}</span>}
    </div>
  </div>;
}
