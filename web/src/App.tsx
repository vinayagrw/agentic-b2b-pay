import { useEffect, useState, type ReactNode } from "react";

const api = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`/api${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};
const usd = (n: number) => `$${(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const Pill = ({ v }: { v: string }) => <span className={`pill ${/allow|approved|matched|clear|settled|pass|applied|confirmed|paid|verified|active|true/.test(v) ? "ok" : /deny|blocked|fail|exception|rejected|suspended|false/.test(v) ? "bad" : "warn"}`}>{v}</span>;
const Card = ({ title, children }: { title: string; children: ReactNode }) => <section className="card"><h2>{title}</h2>{children}</section>;
const Json = ({ v }: { v: unknown }) => <pre>{JSON.stringify(v, null, 2)}</pre>;
const TABS = ["Buyer agent", "Approvals", "Supplier", "Treasury and ledger", "Evidence and audit"] as const;

export function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Buyer agent");
  const [st, setSt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem("theme") ?? "auto"; } catch { return "auto"; } });
  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; try { localStorage.setItem("theme", theme); } catch {} }, [theme]);
  const refresh = async () => setSt(await api("/state"));
  useEffect(() => { refresh().catch((e) => setErr(String(e))); }, []);
  const run = async <T,>(fn: () => Promise<T>) => { setBusy(true); setErr(""); try { const r = await fn(); await refresh(); return r; } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  if (!st) return <main><div className="card">Loading console. Start the BFF on port 8790. {err && <div className="err">{err}</div>}</div></main>;
  const p = { st, run, busy };
  return (
    <>
      <header>
        <h1>Agentic B2B Pay Console</h1>
        <span className="muted">Acme Manufacturing, simulated rails, no real funds</span>
        <span className="sp" />
        <span className="pill">LLM {st.llmMode}</span>
        <Pill v={st.killSwitch ? "kill switch on" : "kill switch off"} />
        <button className={st.killSwitch ? "g" : "r"} disabled={busy} onClick={() => run(() => api("/kill-switch", { on: !st.killSwitch }))}>{st.killSwitch ? "Release kill switch" : "Kill switch"}</button>
        <select style={{ width: 110 }} value={theme} onChange={(e) => setTheme(e.target.value)}><option value="auto">Theme auto</option><option value="light">Light</option><option value="dark">Dark</option></select>
        <button className="g" disabled={busy} onClick={() => run(() => api("/reset", {}))}>Reset demo</button>
      </header>
      <nav>{TABS.map((t) => <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>{t}{t === "Approvals" && st.pos.filter((x: any) => x.status === "pending_approval").length ? ` (${st.pos.filter((x: any) => x.status === "pending_approval").length})` : ""}</button>)}</nav>
      <main>
        {err && <div className="err">{err}</div>}
        {busy && <div className="muted">Working. Live LLM calls can take up to 60 seconds.</div>}
        {tab === "Buyer agent" && <Buyer {...p} />}
        {tab === "Approvals" && <Approvals {...p} />}
        {tab === "Supplier" && <Supplier {...p} />}
        {tab === "Treasury and ledger" && <Treasury {...p} />}
        {tab === "Evidence and audit" && <Evidence {...p} />}
      </main>
    </>
  );
}
type P = { st: any; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; busy: boolean };

function FlowTracker({ st, poId }: { st: any; poId?: string }) {
  const po = st.pos.find((x: any) => x.id === poId);
  if (!po) return <span className="muted">No PO selected yet.</span>;
  const inv = st.invoices.find((i: any) => i.poId === po.id);
  const pi = inv && st.intents.find((i: any) => i.invoiceId === inv.id);
  const s = (name: string, state: "done" | "fail" | "") => <span key={name} className={`step ${state}`}>{name}</span>;
  const settled = pi?.status === "settled";
  return <div className="steps">{[
    s("Need", "done"), s("PO draft", "done"),
    s("Policy check", po.policy.outcome === "deny" ? "fail" : "done"),
    s("Approval", po.status === "rejected" ? "fail" : po.status === "pending_approval" ? "" : "done"),
    s("Goods receipt", st.receipts.some((g: any) => g.poId === po.id) ? "done" : ""),
    s("Supplier invoice", inv ? "done" : ""),
    s("3-way match", inv?.matchStatus === "matched" ? "done" : inv?.matchStatus === "exception" ? "fail" : ""),
    s("Rail choice", pi?.route?.rail ? "done" : pi ? "fail" : ""),
    s("Compliance", pi?.compliance ? (pi.compliance.outcome === "clear" ? "done" : "fail") : ""),
    s("Custody", pi?.custody ? (pi.custody.approved ? "done" : "fail") : pi?.route?.rail && pi.route.rail !== "usdc" && settled ? "done" : ""),
    s("Settlement", settled ? "done" : pi?.status === "blocked" ? "fail" : ""),
    s("Ledger", settled ? "done" : ""), s("ERP sync", settled ? "done" : ""), s("Evidence", "done"),
  ]}</div>;
}

function Buyer({ st, run, busy }: P) {
  const [need, setNeed] = useState("We need 2000 sealed 6204 ball bearings for the line 3 maintenance window next week");
  const [draft, setDraft] = useState<any>(null);
  const [po, setPo] = useState<any>(null);
  const [flow, setFlow] = useState<any>(null);
  const lastPo = po?.id ?? flow?.poId ?? st.pos[st.pos.length - 1]?.id;
  const scenario = async (scenario: string, n = need) => { const r = await run(() => api("/scenario/run", { need: n, scenario })); if (r) { setFlow(r); setPo(null); } };
  return <>
    <Card title="Flow"><FlowTracker st={st} poId={lastPo} /></Card>
    <div className="grid2">
      <Card title="1. Need to PO draft (buyer agent, LLM proposes)">
        <textarea value={need} onChange={(e) => setNeed(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="b" disabled={busy} onClick={async () => { const r: any = await run(() => api("/buyer/draft", { need })); if (r) { setDraft(r); setPo(null); } }}>Draft PO</button>
          <button className="g" disabled={busy || !draft} onClick={async () => { const r = await run(() => api("/purchase-orders", { draft: draft.value })); if (r) setPo(r); }}>Submit PO to policy engine</button>
        </div>
        {draft && <>
          <p>Source <Pill v={draft.source} /> <span className="muted">{draft.note}</span></p>
          <table><thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Unit</th><th>Line</th></tr></thead><tbody>
            {draft.value.lines.map((l: any) => <tr key={l.sku}><td className="mono">{l.sku}</td><td>{l.description}</td><td>{l.qty}</td><td>{usd(l.unitPrice)}</td><td>{usd(l.qty * l.unitPrice)}</td></tr>)}
          </tbody></table>
          <p className="muted">Supplier {draft.value.supplierId}, category {draft.value.category}. Prices are re-read from the catalog, the LLM cannot set them.</p>
        </>}
      </Card>
      <Card title="2. Policy check (deterministic)">
        {po ? <>
          <p>{po.id} total {usd(po.total)} <Pill v={po.policy.outcome} /> status <Pill v={po.status} /> {po.erpRef && <span className="muted">ERP ref {po.erpRef}</span>}</p>
          <table><tbody>{po.policy.checks.map((c: any) => <tr key={c.rule}><td><Pill v={c.pass ? "pass" : "fail"} /></td><td>{c.rule}</td><td className="muted">{c.detail}</td></tr>)}</tbody></table>
        </> : <span className="muted">Submit a draft to see every rule the engine evaluated.</span>}
      </Card>
    </div>
    <Card title="Scenarios (full flow in one click)">
      <div className="row">
        <button className="b" disabled={busy} onClick={() => scenario("happy")}>Happy path to USDC settlement</button>
        <button className="r" disabled={busy} onClick={() => scenario("sanctioned", "Order 2 tons of 304 stainless sheet")}>Blocked sanctioned wallet</button>
        <button className="g" disabled={busy} onClick={() => scenario("poisoned")}>Poisoned invoice tries to change wallet</button>
      </div>
      {flow && <table style={{ marginTop: 10 }}><tbody>{flow.steps.map((s: any, i: number) => <tr key={i}><td><Pill v={s.ok ? "pass" : "fail"} /></td><td style={{ whiteSpace: "nowrap" }}>{s.step}</td><td className="mono">{JSON.stringify(s.detail).slice(0, 320)}</td></tr>)}</tbody></table>}
    </Card>
    <div className="grid2">
      <Card title="Agent identity registry (KYA)">
        <table><thead><tr><th>Agent</th><th>Org</th><th>Role</th><th>KYA</th><th>Status</th><th /></tr></thead><tbody>
          {st.agents.map((a: any) => <tr key={a.id}><td>{a.name}<div className="mono muted">{a.id}</div></td><td>{a.orgId}</td><td>{a.erpRole}</td><td><Pill v={a.kyaStatus} /></td><td><Pill v={a.status} /></td>
            <td><button className="g" disabled={busy} onClick={() => run(() => api(`/agents/${a.id}/${a.status === "active" ? "suspend" : "resume"}`, {}))}>{a.status === "active" ? "Suspend" : "Resume"}</button></td></tr>)}
        </tbody></table>
        {st.mandates.map((m: any) => <p key={m.id} className="muted">Mandate {m.id} signed by {m.principalUserId}: per transaction {usd(m.perTxnMax)}, total {usd(m.maxAmount)}, human approval above {usd(m.approvalThreshold)}, categories {m.allowedCategories.join(", ")}, rails {m.allowedRails.join(", ")}</p>)}
      </Card>
      <Card title="Agent gateway (MCP tools)"><McpTools /></Card>
    </div>
  </>;
}
function McpTools() {
  const [t, setT] = useState<any[]>([]);
  useEffect(() => { api("/mcp/tools").then((r) => setT(r.tools)).catch(() => {}); }, []);
  return <table><tbody>{t.map((x) => <tr key={x.name}><td className="mono">{x.name}</td><td className="muted">{x.description}</td></tr>)}</tbody></table>;
}

function Approvals({ st, run, busy }: P) {
  const pending = st.pos.filter((x: any) => x.status === "pending_approval");
  const [f, setF] = useState({ supplierId: "sup-northwind", field: "walletAddress", newValue: "0x7777000000000000000000000000000000007777", requestedBy: "usr-ap-clerk" });
  return <>
    <Card title="Human approval queue">
      {!pending.length && <span className="muted">Nothing waiting. Try a need above 10,000 USD, for example 30 servo motors.</span>}
      <table><tbody>{pending.map((p: any) => <tr key={p.id}><td className="mono">{p.id}</td><td>{p.supplierId}</td><td>{usd(p.total)}</td><td className="muted">{p.policy.reasons.join(", ")}</td>
        <td className="row"><button className="b" disabled={busy} onClick={() => run(() => api(`/approvals/${p.id}`, { approve: true }))}>Approve</button><button className="g" disabled={busy} onClick={() => run(() => api(`/approvals/${p.id}`, { approve: false }))}>Reject</button></td></tr>)}</tbody></table>
    </Card>
    <Card title="Alerts">
      <table><tbody>{[...st.alerts].reverse().slice(0, 15).map((a: any, i: number) => <tr key={i}><td><Pill v={a.kind} /></td><td>{a.detail}</td><td className="muted">{a.at.slice(11, 19)}</td></tr>)}</tbody></table>
    </Card>
    <Card title="Payee detail changes (ERP master data only, four eyes plus callback)">
      <p className="muted">Bank and wallet details never change from agent or LLM output. A change comes from the ERP vendor master, needs two approvers other than the requester and a phone callback before it applies.</p>
      <div className="row">
        <select style={{ width: 180 }} value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>{st.suppliers.map((s: any) => <option key={s.id}>{s.id}</option>)}</select>
        <select style={{ width: 160 }} value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option>walletAddress</option><option>bankDetailsRef</option></select>
        <input style={{ flex: 1, minWidth: 240 }} value={f.newValue} onChange={(e) => setF({ ...f, newValue: e.target.value })} />
        <button className="b" disabled={busy} onClick={() => run(() => api("/erp/vendor-master/changes", { ...f, source: "erp" }))}>Request via ERP</button>
      </div>
      <table style={{ marginTop: 10 }}><tbody>{st.payeeChanges.map((c: any) => <tr key={c.id}><td className="mono">{c.id}</td><td>{c.supplierId} {c.field}</td><td className="mono">{c.newValue}</td><td>approvals {c.approvals.length} of 2</td><td>callback <Pill v={String(c.callbackVerified)} /></td><td><Pill v={c.status} /></td>
        <td className="row">{c.status === "pending" && <>
          <button className="g" disabled={busy} onClick={() => run(() => api(`/erp/vendor-master/changes/${c.id}/approve`, { approver: "usr-controller-sam" }))}>Approve as Sam</button>
          <button className="g" disabled={busy} onClick={() => run(() => api(`/erp/vendor-master/changes/${c.id}/approve`, { approver: "usr-treasurer-lee" }))}>Approve as Lee</button>
          <button className="g" disabled={busy} onClick={() => run(() => api(`/erp/vendor-master/changes/${c.id}/callback`, { confirmed: true }))}>Callback confirmed</button></>}</td></tr>)}</tbody></table>
    </Card>
  </>;
}

function Supplier({ st, run, busy }: P) {
  const open = st.pos.filter((p: any) => ["approved", "received"].includes(p.status));
  const [poId, setPoId] = useState("");
  const [text, setText] = useState("");
  const [bump, setBump] = useState(0);
  const sel = poId || open[0]?.id || "";
  return <>
    <div className="grid2">
      <Card title="Supplier agent: goods receipt and invoice">
        {!open.length && <span className="muted">No approved POs. Draft and submit one on the Buyer agent tab.</span>}
        {!!open.length && <>
          <div className="row"><select style={{ width: 220 }} value={sel} onChange={(e) => setPoId(e.target.value)}>{open.map((p: any) => <option key={p.id} value={p.id}>{p.id} {p.supplierId} {usd(p.total)} {p.status}</option>)}</select>
            <button className="g" disabled={busy || st.pos.find((p: any) => p.id === sel)?.status !== "approved"} onClick={() => run(() => api("/goods-receipts", { poId: sel }))}>Post goods receipt</button></div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="muted">Price variance percent</label><input style={{ width: 80 }} type="number" value={bump} onChange={(e) => setBump(Number(e.target.value))} />
            <button className="g" disabled={busy} onClick={async () => { const r: any = await run(() => api("/invoices/render", { poId: sel, priceBumpPct: bump })); if (r) setText(r.text); }}>Generate invoice</button>
            <button className="g" disabled={busy} onClick={async () => { const r: any = await run(() => api("/invoices/render", { poId: sel, poison: true })); if (r) setText(r.text); }}>Generate poisoned invoice</button>
          </div>
          <textarea style={{ marginTop: 8, minHeight: 180 }} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="b" disabled={busy || !text} onClick={() => run(() => api("/invoices", { poId: sel, text }))}>Submit invoice (LLM reads it)</button>
        </>}
      </Card>
      <Card title="Supplier master data (read only here)">
        <table><thead><tr><th>Supplier</th><th>ERP</th><th>Preferred</th><th>Wallet</th></tr></thead><tbody>
          {st.suppliers.map((s: any) => <tr key={s.id}><td>{s.name}</td><td>{s.erp}</td><td>{s.preferredRail}</td><td className="mono">{s.walletAddress ?? "none"}</td></tr>)}</tbody></table>
      </Card>
    </div>
    <Card title="Invoices and 3-way match">
      <table><thead><tr><th>Invoice</th><th>PO</th><th>Amount</th><th>Read by</th><th>Injection</th><th>Match</th><th /></tr></thead><tbody>
        {st.invoices.map((i: any) => <tr key={i.id}><td>{i.number}<div className="mono muted">{i.id}</div></td><td className="mono">{i.poId}</td><td>{usd(i.amount)}</td><td className="muted">{i.extractedBy}</td>
          <td>{i.injection?.length ? <Pill v="ignored" /> : "none"}</td><td><Pill v={i.matchStatus} /></td>
          <td>{i.matchStatus === "unmatched" && <button className="b" disabled={busy} onClick={() => run(() => api(`/invoices/${i.id}/match`, {}))}>Run 3-way match</button>}</td></tr>)}</tbody></table>
      {st.invoices.filter((i: any) => i.match).slice(-1).map((i: any) => <div key={i.id} style={{ marginTop: 10 }}><b>Last match {i.number}</b> PO {usd(i.match.totals.po)} invoice {usd(i.match.totals.invoice)} variance {i.match.totals.variancePct} percent, tolerance {i.match.tolerancePct} percent
        <table><thead><tr><th>SKU</th><th>PO qty</th><th>Received</th><th>Invoiced</th><th>PO price</th><th>Inv price</th><th>Result</th></tr></thead><tbody>
          {i.match.lines.map((l: any) => <tr key={l.sku}><td className="mono">{l.sku}</td><td>{l.poQty}</td><td>{l.grQty}</td><td>{l.invQty}</td><td>{usd(l.poPrice)}</td><td>{usd(l.invPrice)}</td><td><Pill v={l.ok ? "pass" : "fail"} /> <span className="muted">{l.note}</span></td></tr>)}</tbody></table></div>)}
    </Card>
  </>;
}

function Treasury({ st, run, busy }: P) {
  const payable = st.invoices.filter((i: any) => i.matchStatus === "matched" && !i.paid);
  const [urgency, setUrgency] = useState("standard");
  const [signers, setSigners] = useState<string[]>(["signer-treasury-ops", "signer-policy-engine"]);
  const [ledger, setLedger] = useState<any>(null);
  const [camt, setCamt] = useState("");
  const [refundAmt, setRefundAmt] = useState(100);
  useEffect(() => { api("/ledger/journals").then(setLedger).catch(() => {}); }, [st]);
  const pi = [...st.intents].reverse()[0];
  return <>
    <Card title="Payment execution">
      <div className="row"><label className="muted">Urgency</label><select style={{ width: 130 }} value={urgency} onChange={(e) => setUrgency(e.target.value)}><option>standard</option><option>urgent</option></select>
        <span className="muted">MPC signers (quorum 2 of 3)</span>
        {st.signers.map((s: any) => <label key={s.id} className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: "auto" }} checked={signers.includes(s.id)} onChange={(e) => setSigners(e.target.checked ? [...signers, s.id] : signers.filter((x) => x !== s.id))} />{s.role}</label>)}</div>
      <table style={{ marginTop: 8 }}><tbody>{payable.map((i: any) => <tr key={i.id}><td>{i.number}</td><td>{i.supplierId}</td><td>{usd(i.amount)}</td>
        <td><button className="b" disabled={busy} onClick={() => run(() => api(`/invoices/${i.id}/pay`, { urgency, approvers: signers }, { "Idempotency-Key": `ui-${i.id}-${Date.now()}` }))}>Route, screen and pay</button></td></tr>)}</tbody></table>
      {!payable.length && <span className="muted">No matched unpaid invoices.</span>}
    </Card>
    {pi && <div className="grid2">
      <Card title={`Rail choice for ${pi.id}`}>
        <p>Status <Pill v={pi.status} /> {pi.route?.rail && <>Rail <b>{pi.route.rail.toUpperCase()}</b></>}</p>
        <p><span className="pill">{pi.explainedBy === "llm" ? "LLM explanation" : "Template explanation"}</span> {pi.explanation}</p>
        <table><thead><tr><th>Rail</th><th>Eligible</th><th>Fee</th><th>Score</th><th>Why</th></tr></thead><tbody>
          {pi.route?.options.map((o: any) => <tr key={o.rail}><td>{o.rail.toUpperCase()}</td><td><Pill v={String(o.eligible)} /></td><td>{usd(o.feeUsd)}</td><td>{o.score}</td><td className="muted">{o.why.join(", ")}</td></tr>)}</tbody></table>
        {pi.blockedReason && <div className="err" style={{ marginTop: 8 }}>{pi.blockedReason}</div>}
      </Card>
      <Card title="Compliance, Travel Rule and custody">
        <table><tbody>{pi.compliance?.checks.map((c: any) => <tr key={c.kind}><td>{c.kind}</td><td><Pill v={c.result} /></td><td className="muted">{c.detail}</td><td className="mono muted">{c.providerRef}</td></tr>)}</tbody></table>
        {pi.compliance?.travelRule && <details><summary>Travel Rule record (IVMS101)</summary><Json v={pi.compliance.travelRule} /></details>}
        {pi.custody && <p>MPC custody <Pill v={pi.custody.approved ? "approved" : "blocked"} /> {pi.custody.shares.length} of {pi.custody.quorum} signers <span className="mono muted">{pi.custody.aggregateSig?.slice(0, 24)}</span></p>}
        {pi.settlementId && (() => { const s = st.settlements.find((x: any) => x.id === pi.settlementId); return <p>Settlement <Pill v={s.status} /> {s.railRef} <span className="mono">{s.txHash}</span></p>; })()}
      </Card>
    </div>}
    <div className="grid2">
      <Card title="Settlements and refunds">
        <table><tbody>{st.settlements.map((s: any) => <tr key={s.id}><td className="mono">{s.id}</td><td>{s.rail.toUpperCase()}</td><td>{usd(st.intents.find((i: any) => i.id === s.paymentIntentId).amount)}</td><td className="mono">{s.txHash ?? s.railRef}</td>
          <td><button className="g" disabled={busy} onClick={() => run(() => api("/refunds", { paymentIntentId: s.paymentIntentId, amount: refundAmt, reason: "Damaged goods credit" }))}>Refund {usd(refundAmt)}</button></td></tr>)}</tbody></table>
        <div className="row" style={{ marginTop: 6 }}><label className="muted">Refund amount</label><input style={{ width: 100 }} type="number" value={refundAmt} onChange={(e) => setRefundAmt(Number(e.target.value))} /><span className="muted">Stablecoin sends are final. A refund is a new forward payment.</span></div>
        <table><tbody>{st.refunds.map((r: any) => <tr key={r.id}><td className="mono">{r.id}</td><td>for {r.originalIntentId}</td><td>{usd(r.amount)}</td><td><Pill v={r.status} /></td><td className="mono">{r.txHash ?? r.railRef}</td></tr>)}</tbody></table>
      </Card>
      <Card title="ERP sync (simulated SAP and Coupa)">
        <table><tbody>{[...st.erp].reverse().slice(0, 12).map((e: any) => <tr key={e.id}><td>{e.system}</td><td className="mono">{e.kind}</td><td><details><summary className="muted">payload</summary><Json v={e.payload} /></details></td></tr>)}</tbody></table>
      </Card>
    </div>
    {ledger && <div className="grid2">
      <Card title="Trial balance">
        <p>Debits {usd(ledger.trialBalance.totalDebit)} credits {usd(ledger.trialBalance.totalCredit)} <Pill v={ledger.trialBalance.balanced ? "balanced" : "unbalanced"} /></p>
        <table><tbody>{Object.entries(ledger.trialBalance.accounts).map(([k, v]: any) => <tr key={k}><td>{k}</td><td>{usd(v.debit)}</td><td>{usd(v.credit)}</td><td><b>{usd(v.balance)}</b></td></tr>)}</tbody></table>
        <h2 style={{ marginTop: 12 }}>Reconciliation</h2>
        <table><tbody>{ledger.reconciliation.map((r: any) => <tr key={r.settlementId}><td className="mono">{r.settlementId}</td><td className="mono">{r.journalId}</td><td><Pill v={r.matched ? "matched" : "exception"} /></td></tr>)}</tbody></table>
        <div className="row" style={{ marginTop: 8 }}><button className="g" onClick={async () => setCamt(await (await fetch("/api/statements/camt053")).text())}>Export camt.053</button><a href="/api/statements/camt053" target="_blank">Open XML</a></div>
        {camt && <pre>{camt}</pre>}
      </Card>
      <Card title="Journal entries (double entry)">
        <table><thead><tr><th>Journal</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>
          {[...ledger.journals].reverse().flatMap((j: any) => j.entries.map((e: any, k: number) => <tr key={e.id}><td>{k === 0 ? <><span className="mono">{j.id}</span><div className="muted">{j.memo}</div></> : ""}</td><td>{e.account}</td><td>{e.debit ? usd(e.debit) : ""}</td><td>{e.credit ? usd(e.credit) : ""}</td></tr>))}</tbody></table>
      </Card>
    </div>}
  </>;
}

function Evidence({ st }: P) {
  const [q, setQ] = useState("");
  const [v, setV] = useState<any>(null);
  useEffect(() => { api("/evidence").then(setV).catch(() => {}); }, [st]);
  if (!v) return null;
  const rows = v.records.filter((r: any) => !q || r.subjectId.includes(q) || r.event.includes(q));
  return <Card title="Hash chained evidence store">
    <div className="row"><span>Chain integrity <Pill v={v.verification.valid ? "verified" : `broken at ${v.verification.brokenAt}`} /></span><span className="muted">{v.records.length} records</span>
      <input style={{ width: 280 }} placeholder="Filter by subject or event, for example pi-" value={q} onChange={(e) => setQ(e.target.value)} />
      <a href={`data:application/json,${encodeURIComponent(JSON.stringify(rows, null, 2))}`} download="evidence-export.json">Export evidence JSON</a></div>
    <table style={{ marginTop: 8 }}><thead><tr><th>#</th><th>Subject</th><th>Event</th><th>Hash</th><th>Prev</th><th>Payload</th></tr></thead><tbody>
      {[...rows].reverse().map((r: any) => <tr key={r.id}><td>{r.seq}</td><td className="mono">{r.subjectType} {r.subjectId}</td><td>{r.event}</td><td className="mono">{r.hash.slice(0, 16)}</td><td className="mono muted">{r.prevHash.slice(0, 16)}</td><td><details><summary className="muted">view</summary><Json v={r.payload} /></details></td></tr>)}</tbody></table>
  </Card>;
}
