import crypto from "node:crypto";
import { isUsdc, type Rail } from "@b2b/shared";
import { sql } from "./db.js";
import { db, save, nextId, tenantOf, type Journal } from "./modules/store.js";
import { makeJournal, trialBalance } from "./modules/ledger.js";
import { appendEvidence } from "./modules/evidence.js";
import { TRAVEL_RULE_THRESHOLD_USD } from "./modules/compliance.js";
import { screenName, screenWallet, sdnStatus } from "./modules/sdn.js";
import { adapter, allAdapters, railReadiness } from "./rails/index.js";
import { callClaude, cleanText } from "./llm.js";
import * as P from "./platform.js";
import * as S from "./service.js";
import * as W from "./workspace.js";

const ev = (t: string, id: string, e: string, p: unknown) => appendEvidence(db.evidence, t, id, e, p);
const now = () => new Date().toISOString();
const err = (s: number, m: string) => new S.HttpError(s, m);
const r2 = (x: number) => Math.round(x * 100) / 100;
const journalsOf = (tenantId: string) => db.journals.filter((j) => tenantOf(j) === tenantId);

// Treasury

export async function treasury(tenantId: string) {
  const balances = await S.railBalances(tenantId);
  const rails = S.railsView(tenantId);
  const cash = balances.reduce((a, b: any) => a + (typeof b.amount === "number" ? b.amount : 0), 0);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const open = db.invoices.filter((i) => tenantOf(i) === tenantId && !i.paid && !db.intents.some((p) => p.invoiceId === i.id && p.status === "settled"));
  const days = Array.from({ length: 31 }, (_, n) => ({ day: new Date(today.getTime() + n * 864e5).toISOString().slice(0, 10), outflow: 0, invoices: [] as string[] }));
  let beyond = 0;
  for (const i of open) {
    const due = Date.parse(i.dueDate); const n = Number.isNaN(due) ? 0 : Math.max(0, Math.floor((due - today.getTime()) / 864e5));
    if (n > 30) { beyond += i.amount; continue; }
    days[n].outflow = r2(days[n].outflow + i.amount); days[n].invoices.push(i.number);
  }
  let bal = cash; const forecast = days.map((d) => { bal = r2(bal - d.outflow); return { ...d, balance: bal }; });
  const tb = trialBalance(journalsOf(tenantId));
  return { tenantId, balances: balances.map((b: any) => ({ ...b, env: P.railEnv(tenantId, b.rail), sweep: adapter(b.rail).sweep ? { supported: true } : { supported: false, reason: adapter(b.rail).sweepUnsupported ?? "Not supported" } })),
    configured: rails.filter((r) => r.configured).length, startingCash: r2(cash), openInvoices: open.length, openAmount: r2(open.reduce((a, i) => a + i.amount, 0)), beyond30: r2(beyond), forecast,
    ledger: Object.entries(tb.accounts).map(([account, v]) => ({ account, ...v })), sweeps: listSweeps(tenantId) };
}
export const listSweeps = (tenantId: string) => (sql.prepare("SELECT data FROM sweeps WHERE tenant_id = ? ORDER BY rowid DESC").all(tenantId) as any[]).map((r) => JSON.parse(r.data));
export async function sweep(user: P.User, tenantId: string, rail: Rail, amount: number) {
  if (!isUsdc(rail)) throw err(422, "Only stablecoin balances can be swept to fiat");
  if (!(amount > 0)) throw err(422, "Amount must be above zero");
  const a = adapter(rail); const env = P.railEnv(tenantId, rail);
  const id = `swp-${crypto.randomUUID().slice(0, 8)}`;
  const base = { id, tenantId, rail, env, amount, requestedBy: user.id, createdAt: now() };
  if (!a.sweep) {
    const rec = { ...base, status: "unsupported", detail: a.sweepUnsupported ?? "This rail has no off ramp" };
    sql.prepare("INSERT INTO sweeps (id, tenant_id, rail, status, data) VALUES (?,?,?,?,?)").run(id, tenantId, rail, rec.status, JSON.stringify(rec));
    P.audit(user.id, "treasury", id, "sweep.unsupported", rec); return rec;
  }
  if (!railReadiness(rail, env).configured) throw err(409, `${rail} is not configured`);
  const r = await a.sweep(amount, env, id);
  const rec = { ...base, status: r.status, providerRef: r.providerRef, detail: r.detail ?? null };
  sql.prepare("INSERT INTO sweeps (id, tenant_id, rail, status, data) VALUES (?,?,?,?,?)").run(id, tenantId, rail, rec.status, JSON.stringify(rec));
  if (r.status === "settled") { db.journals.push({ ...makeJournal(nextId("jnl"), `Sweep ${id} USDC to USD`, id, [{ account: "1000 Cash operating", debit: amount }, { account: "1010 USDC treasury", credit: amount }]), tenantId }); save(); }
  P.audit(user.id, "treasury", id, "sweep.submitted", rec); return rec;
}

// Reconciliation

type Exc = { id: string; tenantId: string; kind: "unmatched" | "amount_mismatch" | "late"; status: "open" | "resolved"; ref: string; intentId: string | null; title: string; expected: number | null; actual: number | null; detectedAt: string; resolution?: { action: string; note: string; by: string; at: string; journalId?: string } };
const putExc = (x: Exc) => sql.prepare("INSERT OR REPLACE INTO recon_exceptions (id, tenant_id, kind, status, data) VALUES (?,?,?,?,?)").run(x.id, x.tenantId, x.kind, x.status, JSON.stringify(x));
const getExc = (id: string) => { const r = sql.prepare("SELECT data FROM recon_exceptions WHERE id = ?").get(id) as any; return r ? (JSON.parse(r.data) as Exc) : null; };
export const listExceptions = (tenantId: string | null) => (sql.prepare(`SELECT data FROM recon_exceptions ${tenantId ? "WHERE tenant_id = ?" : ""} ORDER BY status, rowid DESC`).all(...(tenantId ? [tenantId] : [])) as any[]).map((r) => JSON.parse(r.data) as Exc);
const apDebit = (j: Journal | undefined) => r2(j?.entries.filter((e) => e.account === "2000 Accounts payable").reduce((a, e) => a + e.debit, 0) ?? 0);

/** Matches every rail event to a journal and every webhook to a payment. New problems open exceptions. Resolved ones stay resolved. */
export function runRecon(tenantId: string, at = new Date()) {
  const rows: { settlementId: string; intentId: string; rail: string; providerRef: string; txHash: string | null; amount: number; journalId: string | null; journalAmount: number | null; status: "matched" | "unmatched" | "amount_mismatch" }[] = [];
  const found: Exc[] = [];
  const add = (x: Omit<Exc, "tenantId" | "status" | "detectedAt">) => found.push({ ...x, tenantId, status: "open", detectedAt: now() });
  const intents = db.intents.filter((i) => tenantOf(i) === tenantId && i.kind !== "refund");
  for (const st of db.settlements.filter((s) => intents.some((i) => i.id === s.paymentIntentId))) {
    const pi = intents.find((i) => i.id === st.paymentIntentId)!;
    const j = db.journals.find((x) => x.ref === pi.id && x.memo.startsWith("Payment"));
    const amt = apDebit(j);
    const status = !j ? "unmatched" : amt !== r2(pi.amount) ? "amount_mismatch" : "matched";
    rows.push({ settlementId: st.id, intentId: pi.id, rail: st.rail, providerRef: st.railRef, txHash: st.txHash, amount: pi.amount, journalId: j?.id ?? null, journalAmount: j ? amt : null, status });
    if (status === "unmatched") add({ id: `unmatched:${st.id}`, kind: "unmatched", ref: st.id, intentId: pi.id, title: `Settlement ${st.id} has no ledger journal`, expected: pi.amount, actual: null });
    if (status === "amount_mismatch") add({ id: `amount_mismatch:${st.id}`, kind: "amount_mismatch", ref: st.id, intentId: pi.id, title: `Journal ${j!.id} posts ${amt.toFixed(2)} for a ${pi.amount.toFixed(2)} settlement`, expected: pi.amount, actual: amt });
  }
  const orphans = sql.prepare("SELECT provider, event_id, type, received_at FROM provider_events WHERE intent_id IS NULL AND type LIKE 'payment_intent.%'").all() as any[];
  for (const o of orphans) if (tenantId === "tnt-acme") add({ id: `unmatched:${o.provider}:${o.event_id}`, kind: "unmatched", ref: o.event_id, intentId: null, title: `${o.provider} webhook ${o.type} matches no payment`, expected: null, actual: null });
  for (const pi of intents.filter((i) => i.status === "pending" || i.status === "submitted")) {
    const mins = pi.route?.options.find((o) => o.rail === pi.rail)?.settleMinutes ?? 60;
    const since = Date.parse(pi.timeline?.find((t) => t.status === "submitted")?.at ?? pi.createdAt ?? now());
    const late = (at.getTime() - since) / 60000 - (mins + 30);
    if (late > 0) add({ id: `late:${pi.id}`, kind: "late", ref: pi.id, intentId: pi.id, title: `${pi.id} on ${pi.rail} is ${Math.round(late)} minutes past its expected settlement`, expected: mins, actual: Math.round(late + mins + 30) });
  }
  let opened = 0;
  for (const x of found) { const prior = getExc(x.id); if (prior) continue; putExc(x); opened++; P.audit(null, "recon", x.id, "recon.exception_opened", { kind: x.kind, ref: x.ref }); }
  const matched = rows.filter((r) => r.status === "matched").length;
  return { rows, matched, total: rows.length, opened, exceptions: listExceptions(tenantId) };
}
export async function resolveException(user: P.User, tenantId: string, id: string, action: "accept" | "post_adjustment" | "recheck", note: string) {
  const x = getExc(id); if (!x || x.tenantId !== tenantId) throw err(404, "exception not found");
  if (x.status === "resolved") throw err(409, "Already resolved");
  if (!note.trim() && action !== "recheck") throw err(422, "Add a note that explains the resolution");
  const res: NonNullable<Exc["resolution"]> = { action, note: note.trim().slice(0, 500), by: user.id, at: now() };
  if (action === "post_adjustment") {
    if (x.kind === "late") throw err(422, "A late payment needs a recheck, not a journal");
    const pi = db.intents.find((i) => i.id === x.intentId); if (!pi) throw err(409, "No payment to adjust");
    const diff = r2((x.expected ?? 0) - (x.actual ?? 0)); if (!diff) throw err(409, "Nothing to adjust");
    const cash = isUsdc(pi.rail!) ? "1010 USDC treasury" : "1000 Cash operating";
    const lines = diff > 0 ? [{ account: "2000 Accounts payable", debit: diff }, { account: cash, credit: diff }] : [{ account: cash, debit: -diff }, { account: "2000 Accounts payable", credit: -diff }];
    const j = { ...makeJournal(nextId("jnl"), `Payment adjustment ${x.ref}`, pi.id, lines), tenantId }; db.journals.push(j); res.journalId = j.id; save();
  }
  if (action === "recheck") {
    await S.pollSettlements();
    const pi = db.intents.find((i) => i.id === x.intentId);
    if (pi && (pi.status === "pending" || pi.status === "submitted")) throw err(409, `Still ${pi.status} at the provider. Try again later or accept with a note.`);
    res.note = res.note || `Provider now reports ${pi?.status ?? "no payment"}`;
  }
  x.status = "resolved"; x.resolution = res; putExc(x);
  P.audit(user.id, "recon", x.id, "recon.exception_resolved", res); return x;
}
export function reconCsv(tenantId: string) {
  const { rows } = runRecon(tenantId);
  const q = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return ["settlement_id,payment_id,rail,provider_ref,tx_hash,amount_usd,journal_id,journal_amount_usd,status", ...rows.map((r) => [r.settlementId, r.intentId, r.rail, r.providerRef, r.txHash, r.amount.toFixed(2), r.journalId, r.journalAmount?.toFixed(2), r.status].map(q).join(","))].join("\n") + "\n";
}

// Compliance cases

/** A payment blocked by a list hit opens a sanctions case with the hits and the Travel Rule record. */
export function caseForBlockedPayment(intentId: string) {
  const pi = db.intents.find((i) => i.id === intentId); if (!pi?.compliance) return null;
  const hits = pi.compliance.hits ?? []; if (!hits.length) return null;
  if (S.listCases(tenantOf(pi)).some((c) => c.intentId === pi.id && c.kind === "sanctions")) return null;
  const inv = db.invoices.find((i) => i.id === pi.invoiceId); const sup = inv && db.suppliers.find((s) => s.id === inv.supplierId);
  return S.openCase({ tenantId: tenantOf(pi), kind: "sanctions", intentId: pi.id, title: `Sanctions hit on payment to ${sup?.name ?? "supplier"}`, detail: { subject: sup?.name ?? null, supplierId: sup?.id ?? null, amount: pi.amount, rail: pi.route?.rail ?? null, hits, checks: pi.compliance.checks, travelRule: pi.compliance.travelRule ?? null } });
}
/** Screens supplier onboarding submissions. Hits open a case and stop verification. */
W.setSupplierScreen((name, wallet) => ({ hits: [...screenName(name), ...screenWallet(wallet)] }));
export function caseForSupplier(supplierId: string) {
  const s = db.suppliers.find((x) => x.id === supplierId); const hits = s?.onboarding?.screening?.hits ?? [];
  if (!s || !hits.length) return null;
  return S.openCase({ tenantId: tenantOf(s), kind: "sanctions", intentId: null, title: `Sanctions hit on supplier onboarding ${s.name}`, detail: { subject: s.onboarding!.kyb?.legalName ?? s.name, supplierId: s.id, amount: null, rail: null, hits, checks: [], travelRule: null } });
}
export function travelRuleRecords(tenantId: string | null) {
  return db.intents.filter((i) => (!tenantId || tenantOf(i) === tenantId) && i.compliance?.travelRule && i.amount >= TRAVEL_RULE_THRESHOLD_USD)
    .map((i) => ({ intentId: i.id, tenantId: tenantOf(i), amount: i.amount, status: i.status, rail: i.rail ?? i.route?.rail ?? null, createdAt: i.createdAt ?? null, record: i.compliance!.travelRule }));
}
function sarTemplate(c: S.Case) {
  const d = c.detail ?? {}; const hits = (d.hits ?? []) as any[];
  const who = d.subject ?? "the counterparty";
  const lines = hits.map((h) => `${h.source} entry ${h.uid} (${h.sdnName}, program ${h.program}) matched on ${h.matchedOn} "${h.value}" with score ${h.score}`);
  return [
    `Subject: ${who}${d.supplierId ? ` (supplier ${d.supplierId})` : ""}.`,
    `Activity: ${d.amount ? `an outbound payment of ${Number(d.amount).toFixed(2)} USD${d.rail ? ` on ${d.rail}` : ""}` : "a supplier onboarding submission"} was stopped by automated screening on ${c.openedAt.slice(0, 10)}. No funds moved.`,
    `Screening results: ${lines.join(". ") || "no list detail recorded"}.`,
    d.travelRule ? `Travel Rule record: originator ${d.travelRule.originator?.legalPerson ?? "unknown"}, beneficiary ${d.travelRule.beneficiary?.legalPerson ?? "unknown"}, wallet ${d.travelRule.beneficiary?.wallet ?? "none"}.` : "No Travel Rule record applies.",
    "Action taken: payment blocked before submission to the rail, case opened for review, supplier held from further payments.",
    "Reviewer to confirm: whether the match is a true match, the relationship history with the subject, and any related payments.",
  ].join("\n\n");
}
export async function draftSar(user: P.User, id: string) {
  const c = S.getCase(id); if (!c) throw err(404, "case not found");
  if (c.sar?.status === "filed-internally") throw err(409, "This SAR is already filed");
  const facts = sarTemplate(c);
  const r = await callClaude(`You are a bank financial crimes analyst. Draft a Suspicious Activity Report narrative for internal review from ONLY these facts. Use plain sentences in five short paragraphs: who, what, when, why it is suspicious, what was done. Do not invent facts, names or amounts. Do not use em dashes or semicolons. Facts:\n${facts}`);
  const text = r.text ? cleanText(r.text) : facts;
  c.sar = { status: "draft", text, draftedBy: r.text ? `claude (${r.ms} ms)` : `template (${r.error ?? "mock mode"})`, updatedBy: user.id, updatedAt: now() };
  S.saveCase(c); P.audit(user.id, "case", c.id, "sar.drafted", { draftedBy: c.sar.draftedBy }); return c;
}
export function editSar(user: P.User, id: string, text: string) {
  const c = S.getCase(id); if (!c?.sar) throw err(404, "No SAR draft on this case");
  if (c.sar.status !== "draft") throw err(409, "Filed SARs cannot change");
  c.sar = { ...c.sar, text: cleanText(text).slice(0, 8000), updatedBy: user.id, updatedAt: now() }; S.saveCase(c); P.audit(user.id, "case", c.id, "sar.edited", {}); return c;
}
export function fileSar(user: P.User, id: string) {
  const c = S.getCase(id); if (!c?.sar) throw err(404, "Draft a SAR first");
  if (c.sar.status !== "draft") throw err(409, "Already filed");
  c.sar = { ...c.sar, status: "filed-internally", filedBy: user.id, filedAt: now() }; S.saveCase(c); P.audit(user.id, "case", c.id, "sar.filed_internally", {}); return c;
}
export function closeCase(user: P.User, id: string, resolution: string) {
  const c = S.getCase(id); if (!c) throw err(404, "case not found");
  if (c.status === "closed") throw err(409, "Already closed");
  if (!resolution.trim()) throw err(422, "Say why the case is closed");
  c.status = "closed"; c.closedBy = user.id; c.closedAt = now(); c.resolution = resolution.trim().slice(0, 500); S.saveCase(c); P.audit(user.id, "case", c.id, "case.closed", { resolution: c.resolution }); return c;
}
S.blockHooks.push((id) => { caseForBlockedPayment(id); });
W.submitHooks.push((id) => { caseForSupplier(id); });
export const complianceStatus = () => ({ sdn: sdnStatus(), travelRuleThresholdUsd: TRAVEL_RULE_THRESHOLD_USD });
