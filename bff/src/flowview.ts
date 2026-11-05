import { db, scoped, tenantOf, type PaymentIntent } from "./modules/store.js";
import * as P from "./platform.js";
import * as S from "./service.js";
import * as CARDS from "./cards.js";
import { allAdapters, railReadiness } from "./rails/index.js";

/** Step state on the flow diagram. All derived from stored records, never guessed. */
export type StepStatus = "done" | "failed" | "blocked" | "running" | "waiting" | "skipped" | "not_reached";
export type Actor = { kind: "agent" | "person" | "system"; name: string };
export type FlowStep = { key: string; label: string; status: StepStatus; actor: Actor | null; at: string | null; durationMs: number | null; reason: string | null; details: Record<string, unknown> };

export const STEP_KEYS = ["need", "po", "policy", "approval", "match", "route", "compliance", "custody", "submitted", "settled", "ledger", "erp"] as const;
const LABEL: Record<string, string> = { need: "Need", po: "PO", policy: "Policy", approval: "Approval", match: "Match", route: "Route", compliance: "Compliance", custody: "Custody", submitted: "Rail submitted", settled: "Settled", ledger: "Ledger", erp: "ERP" };
const isUsdc = (r?: string | null) => r === "circle_usdc" || r === "onchain_usdc";
const userName = (id: string) => P.getUser(id)?.name ?? id;

/** One payment's flow from need to ERP, with actor, time and duration for every step. */
export function flowSummary(intentId: string, scope: string | null = null) {
  const pi = db.intents.find((i) => i.id === intentId);
  if (!pi || (scope && tenantOf(pi) !== scope)) throw new S.HttpError(404, "payment not found");
  const inv = db.invoices.find((i) => i.id === pi.invoiceId) ?? null;
  const po = inv ? db.pos.find((p) => p.id === inv.poId) ?? null : null;
  const sup = inv ? db.suppliers.find((s) => s.id === inv.supplierId) ?? null : null;
  const agent = po ? db.agents.find((a) => a.id === po.agentId) ?? null : null;
  const evOf = (subjectId: string | undefined, event: string) => subjectId ? [...db.evidence].reverse().find((e) => e.subjectId === subjectId && e.event === event) ?? null : null;
  const tl = (status: string) => pi.timeline?.find((t) => t.status === status) ?? null;
  const agentActor: Actor | null = agent ? { kind: "agent", name: agent.name } : null;
  const sys = (name: string): Actor => ({ kind: "system", name });
  const raw: Omit<FlowStep, "durationMs" | "label">[] = [];
  const add = (key: string, s: Omit<FlowStep, "durationMs" | "label" | "key">) => raw.push({ key, ...s });

  add("need", po ? { status: "done", actor: agentActor, at: po.createdAt, reason: null, details: { justification: po.justification, category: po.category } } : { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  add("po", po ? { status: "done", actor: agentActor, at: po.createdAt, reason: null, details: { poId: po.id, erpRef: po.erpRef, total: po.total, lines: po.lines } } : { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  if (po) {
    const pe = evOf(po.id, "policy.evaluated");
    const out = po.policy.outcome;
    add("policy", { status: out === "deny" ? "blocked" : "done", actor: sys("Policy engine"), at: pe?.createdAt ?? po.createdAt, reason: out === "deny" ? po.policy.reasons.join(". ") : null, details: { outcome: out, checks: po.policy.checks, reasons: po.policy.reasons } });
    const ap = po.approval; const all = ap?.levels.flatMap((l) => l.approvals) ?? [];
    if (ap?.rejectedBy) add("approval", { status: "failed", actor: { kind: "person", name: userName(ap.rejectedBy.userId) }, at: ap.rejectedBy.at, reason: ap.rejectedBy.comment || "Rejected", details: { rule: ap.ruleName, levels: ap.levels } });
    else if (po.status === "pending_approval") add("approval", { status: "waiting", actor: null, at: null, reason: "Waiting for an approver", details: { rule: ap?.ruleName ?? null, levels: ap?.levels ?? [] } });
    else if (all.length) { const last = all.reduce((a, x) => (x.at > a.at ? x : a)); add("approval", { status: "done", actor: { kind: "person", name: [...new Set(all.map((x) => userName(x.userId)))].join(", ") }, at: last.at, reason: null, details: { rule: ap?.ruleName ?? null, levels: ap?.levels ?? [] } }); }
    else add("approval", { status: "skipped", actor: sys("Policy engine"), at: null, reason: "Not needed under policy", details: {} });
  } else { add("policy", { status: "not_reached", actor: null, at: null, reason: null, details: {} }); add("approval", { status: "not_reached", actor: null, at: null, reason: null, details: {} }); }
  if (inv) {
    const me = evOf(inv.id, "match.three_way");
    add("match", { status: inv.matchStatus === "matched" ? "done" : inv.matchStatus === "exception" ? "failed" : "waiting", actor: sys("Matching engine"), at: me?.createdAt ?? null, reason: inv.matchStatus === "exception" ? "Invoice does not match PO and goods receipt" : null, details: { invoice: inv.number, amount: inv.amount, match: inv.match ?? null, extractedBy: inv.extractedBy } });
  } else add("match", { status: "not_reached", actor: null, at: null, reason: null, details: {} });

  const stopped = pi.status === "blocked" || pi.status === "denied" || pi.status === "failed";
  const re = evOf(pi.id, "route.decided");
  if (pi.route) add("route", { status: pi.route.rail ? "done" : "blocked", actor: sys("Router"), at: re?.createdAt ?? tl("routed")?.at ?? null, reason: pi.route.rail ? null : pi.route.reason, details: { rail: pi.route.rail, reason: pi.route.reason, options: pi.route.options } });
  else add("route", pi.status === "denied" ? { status: "blocked", actor: sys("Platform"), at: tl("denied")?.at ?? null, reason: pi.blockedReason ?? "Denied", details: {} } : { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  const ce = evOf(pi.id, "compliance.screened");
  if (pi.compliance) add("compliance", { status: pi.compliance.outcome === "clear" ? "done" : "blocked", actor: sys("Compliance screening"), at: ce?.createdAt ?? null, reason: pi.compliance.outcome === "blocked" ? pi.compliance.checks.filter((c) => c.result === "fail").map((c) => c.detail).join(". ") : null, details: { outcome: pi.compliance.outcome, checks: pi.compliance.checks, hits: pi.compliance.hits ?? [] } });
  else add("compliance", { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  const ke = evOf(pi.id, "custody.mpc_sign"); const cust = pi.custody as any;
  if (cust) add("custody", { status: cust.approved ? "done" : "blocked", actor: sys("MPC custody"), at: ke?.createdAt ?? null, reason: cust.approved ? null : `Signing quorum not met: ${cust.shares?.length ?? 0} of ${cust.quorum}`, details: { signers: (cust.shares ?? []).map((s: any) => s.signer), quorum: cust.quorum, digest: cust.digest } });
  else if (pi.compliance?.outcome === "clear" && pi.route?.rail && !isUsdc(pi.route.rail)) add("custody", { status: "skipped", actor: null, at: null, reason: "Card and bank rails do not need wallet signing", details: {} });
  else add("custody", { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  const sub = tl("submitted"); const fail = tl("failed");
  const links = { providerRef: pi.providerRef ?? null, dashboardUrl: pi.dashboardUrl ?? null, explorerUrl: pi.explorerUrl ?? null, env: pi.env ?? null, rail: pi.rail ?? null };
  if (sub) add("submitted", { status: fail && !tl("pending") ? "failed" : "done", actor: sys(pi.rail ?? "Rail"), at: sub.at, reason: fail && !tl("pending") ? fail.detail : null, details: links });
  else add("submitted", { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  const st = pi.settlementId ? db.settlements.find((s) => s.id === pi.settlementId) ?? null : null; const se = tl("settled");
  if (se) add("settled", { status: "done", actor: sys(se.source === "webhook" ? `${pi.rail} webhook` : se.source === "watcher" ? "Settlement watcher" : pi.rail ?? "Rail"), at: se.at, reason: null, details: { ...links, settlementId: st?.id, txHash: st?.txHash, feeUsd: st?.feeUsd, chain: st?.chain } });
  else if (pi.status === "pending" || pi.status === "submitted") add("settled", { status: "running", actor: sys(pi.rail ?? "Rail"), at: null, reason: "Waiting for the rail to confirm", details: links });
  else if (pi.status === "failed" && tl("pending")) add("settled", { status: "failed", actor: sys(pi.rail ?? "Rail"), at: fail?.at ?? null, reason: pi.blockedReason ?? "Provider reported failure", details: links });
  else add("settled", { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  const js = db.journals.filter((j) => j.ref === pi.id);
  add("ledger", js.length ? { status: "done", actor: sys("Ledger"), at: js[0].createdAt, reason: null, details: { journals: js.map((j) => ({ id: j.id, memo: j.memo, entries: j.entries })) } } : { status: "not_reached", actor: null, at: null, reason: null, details: {} });
  const ee = evOf(pi.id, "erp.payment_posted");
  add("erp", ee ? { status: "done", actor: sys(sup?.erp ?? "ERP"), at: ee.createdAt, reason: null, details: ee.payload as Record<string, unknown> } : { status: "not_reached", actor: null, at: null, reason: null, details: {} });

  // A stop marks every later step as not reached, so the diagram shows where the flow ended.
  let prev: string | null = null; let ended = false;
  const steps: FlowStep[] = raw.map((s) => {
    const out: FlowStep = { ...s, label: LABEL[s.key], status: ended && s.status !== "done" ? "not_reached" : s.status, durationMs: s.at && prev ? Math.max(0, Date.parse(s.at) - Date.parse(prev)) : null };
    if (s.at) prev = s.at;
    if (s.status === "blocked" || s.status === "failed") ended = true;
    return out;
  });
  return {
    intent: { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency, rail: pi.rail ?? pi.route?.rail ?? null, env: pi.env ?? null, tenantId: tenantOf(pi), supplier: sup?.name ?? null, createdAt: pi.createdAt ?? null, blockedReason: pi.blockedReason ?? null },
    steps,
    decision: explainer(pi),
  };
}

/** What the model said, what the rules decided, and which one counts. */
export function explainer(pi: PaymentIntent) {
  const r = pi.route;
  return {
    deterministic: r ? { rail: r.rail, reason: r.reason, options: r.options } : null,
    explanation: pi.explanation ?? null,
    explainedBy: pi.explainedBy ?? null,
    decidedBy: "router" as const,
  };
}

export type TxQuery = { status?: string; rail?: string; tenant?: string; from?: string; to?: string; min?: string | number; max?: string | number; q?: string; sort?: string; dir?: string; limit?: string | number };
/** Payments as table rows with filters, search and sort. */
export function transactions(scope: string | null, f: TxQuery = {}) {
  const d = scoped(scope); const tenants = new Map(P.listTenants().map((t) => [t.id, t.name]));
  let rows: { id: string; kind: string; createdAt: string; status: string; amount: number; rail: string; env: string; tenantId: string; tenant: string; supplier: string; invoice: string; providerRef: string; reason: string }[] = d.intents.map((i) => {
    const inv = db.invoices.find((x) => x.id === i.invoiceId); const sup = inv && db.suppliers.find((s) => s.id === inv.supplierId);
    return { id: i.id, kind: i.kind ?? "payment", createdAt: i.createdAt ?? "", status: i.status, amount: i.amount, rail: i.rail ?? i.route?.rail ?? "", env: i.env ?? "", tenantId: tenantOf(i), tenant: tenants.get(tenantOf(i)) ?? tenantOf(i), supplier: sup?.name ?? "", invoice: inv?.number ?? "", providerRef: i.providerRef ?? "", reason: i.blockedReason ?? "" };
  });
  // Card authorizations and captures from virtual cards.
  rows = [...rows, ...CARDS.txRows(scope)];
  const num = (v: unknown) => (v === undefined || v === "" ? null : Number(v));
  const min = num(f.min), max = num(f.max);
  if (f.status) { const set = new Set(String(f.status).split(",")); rows = rows.filter((r) => set.has(r.status)); }
  if (f.rail) rows = rows.filter((r) => r.rail === f.rail);
  if (f.tenant) rows = rows.filter((r) => r.tenantId === f.tenant);
  if (f.from) rows = rows.filter((r) => r.createdAt.slice(0, 10) >= String(f.from));
  if (f.to) rows = rows.filter((r) => r.createdAt.slice(0, 10) <= String(f.to));
  if (min !== null && !Number.isNaN(min)) rows = rows.filter((r) => r.amount >= min);
  if (max !== null && !Number.isNaN(max)) rows = rows.filter((r) => r.amount <= max);
  if (f.q) { const q = String(f.q).toLowerCase(); rows = rows.filter((r) => [r.id, r.supplier, r.invoice, r.providerRef, r.tenant].some((x) => x.toLowerCase().includes(q))); }
  const key = (["createdAt", "amount", "status", "rail", "tenant", "supplier"].includes(String(f.sort)) ? f.sort : "createdAt") as keyof typeof rows[number];
  const dir = f.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.id.localeCompare(b.id)) * dir);
  const total = rows.length; const lim = num(f.limit);
  return { total, rows: lim ? rows.slice(0, lim) : rows };
}
const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function transactionsCsv(scope: string | null, f: TxQuery = {}) {
  const cols = ["id", "createdAt", "status", "amount", "rail", "env", "tenant", "supplier", "invoice", "providerRef", "reason"] as const;
  return [cols.join(","), ...transactions(scope, f).rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

/** Latest payment events from the evidence chain, newest first. */
export function liveFeed(scope: string | null, limit = 50) {
  const d = scoped(scope); const ids = new Map(d.intents.map((i) => [i.id, i]));
  return d.evidence.filter((e) => e.subjectType === "payment" && ids.has(e.subjectId)).slice(-limit).reverse().map((e) => {
    const i = ids.get(e.subjectId)!;
    return { seq: e.seq, at: e.createdAt, event: e.event, intentId: i.id, amount: i.amount, status: i.status, rail: i.rail ?? i.route?.rail ?? null, tenantId: tenantOf(i) };
  });
}

/** Settled volume tenant to rail to supplier, plus blocked volume to a Blocked node. */
export function sankey(days = 30, now = Date.now()) {
  const since = now - days * 864e5; const tenants = new Map(P.listTenants().map((t) => [t.id, t.name]));
  const nodes: { id: string; name: string; kind: "tenant" | "rail" | "supplier" | "blocked" }[] = []; const idx = new Map<string, number>();
  const node = (id: string, name: string, kind: typeof nodes[number]["kind"]) => { if (!idx.has(id)) { idx.set(id, nodes.length); nodes.push({ id, name, kind }); } return idx.get(id)!; };
  const links = new Map<string, { source: number; target: number; value: number }>();
  const link = (a: number, b: number, v: number) => { const k = `${a}>${b}`; const l = links.get(k) ?? { source: a, target: b, value: 0 }; l.value = Math.round((l.value + v) * 100) / 100; links.set(k, l); };
  let settled = 0, blocked = 0;
  for (const i of db.intents) {
    if (i.kind === "refund" || Date.parse(i.createdAt ?? "1970") < since) continue;
    const t = node(`t:${tenantOf(i)}`, tenants.get(tenantOf(i)) ?? tenantOf(i), "tenant");
    if (i.status === "settled" && i.rail) {
      const inv = db.invoices.find((x) => x.id === i.invoiceId); const sup = inv && db.suppliers.find((s) => s.id === inv.supplierId);
      const r = node(`r:${i.rail}`, i.rail, "rail"); const s = node(`s:${sup?.id ?? "unknown"}`, sup?.name ?? "Unknown supplier", "supplier");
      link(t, r, i.amount); link(r, s, i.amount); settled += i.amount;
    } else if (i.status === "blocked" || i.status === "denied") { link(t, node("blocked", "Blocked", "blocked"), i.amount); blocked += i.amount; }
  }
  // Drop tenants with no flow in range so the chart has no orphan nodes.
  const used = new Set([...links.values()].flatMap((l) => [l.source, l.target]));
  const keep = nodes.map((_, n) => used.has(n)); const remap = new Map<number, number>(); let k = 0; keep.forEach((y, n) => { if (y) remap.set(n, k++); });
  return { days, settledVolume: Math.round(settled * 100) / 100, blockedVolume: Math.round(blocked * 100) / 100, nodes: nodes.filter((_, n) => keep[n]), links: [...links.values()].map((l) => ({ source: remap.get(l.source)!, target: remap.get(l.target)!, value: l.value })) };
}

/** Daily series for sparklines and rail health, scoped to a tenant or all tenants. */
export function homeInsights(scope: string | null, days = 14, now = Date.now()) {
  const d = scoped(scope); const since = now - days * 864e5;
  const pays = d.intents.filter((i) => i.kind !== "refund");
  const dayKeys = Array.from({ length: days }, (_, n) => new Date(now - (days - 1 - n) * 864e5).toISOString().slice(0, 10));
  const series = dayKeys.map((day) => {
    const of = pays.filter((i) => (i.createdAt ?? "").slice(0, 10) === day);
    const set = of.filter((i) => i.status === "settled");
    return { day, payments: of.length, settledVolume: Math.round(set.reduce((a, i) => a + i.amount, 0) * 100) / 100, blocked: of.filter((i) => i.status === "blocked" || i.status === "denied").length, failed: of.filter((i) => i.status === "failed").length };
  });
  const tenantId = scope ?? "tnt-acme";
  const rails = allAdapters().map((a) => {
    const env = P.railEnv(tenantId, a.id); const rd = railReadiness(a.id, env);
    const used = pays.filter((i) => i.rail === a.id && Date.parse(i.createdAt ?? "1970") >= since);
    const ok = used.filter((i) => i.status === "settled"); const bad = used.filter((i) => i.status === "failed");
    const last = ok.map((i) => i.timeline?.find((t) => t.status === "settled")?.at ?? "").filter(Boolean).sort().pop() ?? null;
    const done = ok.length + bad.length;
    return { rail: a.id, configured: rd.configured, notConfiguredReason: rd.configured ? null : rd.reason ?? null, env, lastSuccess: last, attempts: done, errorRate: done ? Math.round((bad.length / done) * 1000) / 10 : null };
  });
  return { days, series, rails, inFlight: pays.filter((i) => i.status === "pending" || i.status === "submitted").length };
}
