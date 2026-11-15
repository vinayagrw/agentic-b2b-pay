import crypto from "node:crypto";
import { sql } from "./db.js";
import { db, tenantOf } from "./modules/store.js";
import * as S from "./service.js";
import * as P from "./platform.js";

/** Bank statement import (camt.053 XML and MT940 text) and matching of statement lines to settled payments. Sandbox only. */
export type StmtLine = { amount: number; currency: string; direction: "debit" | "credit"; valueDate: string; endToEndId: string | null; bankRef: string | null; info: string | null };
export type Parsed = { format: "camt053" | "mt940"; statementId: string; account: string | null; seq: string | null; lines: StmtLine[] };
export type Line = StmtLine & { id: string; tenantId: string; statementId: string; status: "unmatched" | "matched" | "ignored"; settlementId: string | null; intentId: string | null; resolution?: { action: string; note: string; by: string; at: string; approvedBy?: string; difference?: number | null }; pendingChangeId?: string | null };

const err = (s: number, m: string) => new S.HttpError(s, m);
const now = () => new Date().toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;
const ref = (x: string | null | undefined) => { const v = (x ?? "").trim(); return !v || /^(NOTPROVIDED|NONREF)$/i.test(v) ? null : v; };
const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;
const unesc = (s: string | null) => s && s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseCamt(xml: string): Parsed {
  const count = (xml.match(/<Stmt>/g) ?? []).length;
  if (count > 1) throw err(422, "The camt.053 file has more than one statement. Upload one statement per file.");
  const stmt = tag(xml, "Stmt"); if (!stmt) throw err(422, "camt.053 file has no Stmt block");
  const lines = [...stmt.matchAll(/<Ntry>([\s\S]*?)<\/Ntry>/g)].map(([, n]) => {
    const amt = n.match(/<Amt\s+Ccy="([A-Z]{3})">([\d.]+)<\/Amt>/); if (!amt) throw err(422, "camt.053 entry has no amount");
    const vd = tag(tag(n, "ValDt") ?? "", "Dt") ?? tag(tag(n, "BookgDt") ?? "", "Dt");
    if (!vd) throw err(422, "camt.053 entry has no value date");
    return { amount: r2(Number(amt[2])), currency: amt[1], direction: tag(n, "CdtDbtInd") === "CRDT" ? "credit" as const : "debit" as const, valueDate: vd.slice(0, 10), endToEndId: ref(unesc(tag(n, "EndToEndId"))), bankRef: ref(unesc(tag(n, "AcctSvcrRef"))), info: unesc(tag(n, "AddtlTxInf")) ?? unesc(tag(n, "AddtlNtryInf")) };
  });
  const acct = tag(stmt, "Acct") ?? ""; const account = unesc(tag(acct, "IBAN") ?? tag(acct, "Othr") ?? null);
  const seq = tag(stmt, "ElctrncSeqNb") ?? tag(stmt, "LglSeqNb") ?? tag(stmt, "CreDtTm");
  return { format: "camt053", statementId: unesc(stmt.replace(/<Acct>[\s\S]*?<\/Acct>/g, "").match(/<Id>([^<]*)<\/Id>/)?.[1]?.trim() ?? null) || "unknown", account, seq, lines };
}

function parseMt940(text: string): Parsed {
  const fields = text.replace(/\r/g, "").split(/\n(?=:\d{2}[A-Z]?:)/).map((f) => f.trim());
  const get = (t: string) => fields.find((f) => f.startsWith(`:${t}:`))?.slice(t.length + 2).trim();
  const bal = (get("60F") ?? get("60M") ?? "").match(/^[CD]\d{6}([A-Z]{3})/); const ccy = bal?.[1] ?? "USD";
  const lines: StmtLine[] = [];
  for (const f of fields) {
    if (f.startsWith(":61:")) {
      const m = f.slice(4).split("\n")[0].match(/^(\d{2})(\d{2})(\d{2})(?:\d{4})?(R?[CD])[A-Z]?([\d,]+)[A-Z]([A-Z0-9]{3})([^/]*)(?:\/\/(.*))?$/);
      if (!m) throw err(422, `MT940 line not readable: ${f.slice(0, 40)}`);
      lines.push({ amount: r2(Number(m[5].replace(",", "."))), currency: ccy, direction: m[4].endsWith("C") ? "credit" : "debit", valueDate: `20${m[1]}-${m[2]}-${m[3]}`, endToEndId: ref(m[7]), bankRef: ref(m[8]), info: null });
    } else if (f.startsWith(":86:") && lines.length) lines[lines.length - 1].info = f.slice(4).replace(/\n/g, " ").trim();
  }
  return { format: "mt940", statementId: get("20") ?? "unknown", account: get("25") ?? null, seq: get("28C") ?? get("28") ?? null, lines };
}

export function parseStatement(content: string): Parsed {
  const c = content.trim();
  if (c.startsWith("<") && /BkToCstmrStmt/.test(c)) return parseCamt(c);
  if (/^:20:/m.test(c) && /^:61:/m.test(c)) return parseMt940(c);
  throw err(422, "The file is not a camt.053 or MT940 statement");
}

const rowLine = (r: any) => JSON.parse(r.data) as Line;
const putLine = (l: Line) => sql.prepare("INSERT OR REPLACE INTO bank_statement_lines (id, tenant_id, statement_id, status, settlement_id, data) VALUES (?,?,?,?,?,?)").run(l.id, l.tenantId, l.statementId, l.status, l.settlementId, JSON.stringify(l));
const linesOf = (tenantId: string) => (sql.prepare("SELECT data FROM bank_statement_lines WHERE tenant_id = ? ORDER BY rowid").all(tenantId) as any[]).map(rowLine);
const getLine = (tenantId: string, id: string) => { const r = sql.prepare("SELECT data FROM bank_statement_lines WHERE id = ? AND tenant_id = ?").get(id, tenantId); if (!r) throw err(404, `Statement line ${id} not found`); return rowLine(r); };

/** Settled, not returned payments of this tenant that no statement line has claimed yet. */
function openSettlements(tenantId: string) {
  const taken = new Set((sql.prepare("SELECT settlement_id FROM bank_statement_lines WHERE tenant_id = ? AND settlement_id IS NOT NULL").all(tenantId) as any[]).map((r) => r.settlement_id));
  return db.settlements.filter((s) => s.status === "confirmed" && !taken.has(s.id)).map((s) => ({ s, pi: db.intents.find((i) => i.id === s.paymentIntentId) })).filter((x) => x.pi && tenantOf(x.pi) === tenantId && x.pi.status === "settled");
}
const days = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5;

/** Matches unmatched debit lines by amount, currency, value date within 2 days and end to end reference. */
export function autoMatch(tenantId: string) {
  let matched = 0;
  for (const l of linesOf(tenantId).filter((x) => x.status === "unmatched" && x.direction === "debit" && x.endToEndId)) {
    const hit = openSettlements(tenantId).find(({ s, pi }) => r2(pi!.amount) === l.amount && pi!.currency === l.currency && days(s.confirmedAt, l.valueDate) <= 2 && [pi!.id, s.railRef, s.txHash].includes(l.endToEndId));
    if (!hit) continue;
    putLine({ ...l, status: "matched", settlementId: hit.s.id, intentId: hit.pi!.id, resolution: { action: "auto_match", note: "Amount, currency, value date and reference agree", by: "system", at: now() } });
    P.audit(null, "bank_statement", l.id, "bank_statement.line_matched", { settlementId: hit.s.id, auto: true }); matched++;
  }
  return matched;
}

export function importStatement(user: P.User, tenantId: string, filename: string, content: string) {
  if (!content?.trim()) throw err(422, "Upload a statement file");
  if (content.length > 2_000_000) throw err(413, "Statement file is too large");
  const parsed = parseStatement(content);
  const hash = crypto.createHash("sha256").update(content.trim()).digest("hex");
  // Same content, or the same statement id on the same account with the same sequence (or first value date). A missing id never counts.
  const seq = parsed.seq ?? parsed.lines.map((l) => l.valueDate).sort()[0] ?? null;
  const key = parsed.statementId !== "unknown" && seq ? `${parsed.statementId}|${parsed.account ?? ""}|${seq}` : null;
  const dup = sql.prepare("SELECT id FROM bank_statements WHERE tenant_id = ? AND (hash = ? OR (? IS NOT NULL AND json_extract(data, '$.dupKey') = ?))").get(tenantId, hash, key, key) as any;
  if (dup) throw err(409, `This statement was already imported as ${dup.id}`);
  const id = `bst-${crypto.randomUUID().slice(0, 8)}`;
  const rec = { id, tenantId, filename: String(filename || "statement").slice(0, 120), format: parsed.format, statementId: parsed.statementId, account: parsed.account, seq, dupKey: key, lineCount: parsed.lines.length, importedBy: user.id, importedAt: now() };
  sql.transaction(() => {
    sql.prepare("INSERT INTO bank_statements (id, tenant_id, hash, format, data) VALUES (?,?,?,?,?)").run(id, tenantId, hash, parsed.format, JSON.stringify(rec));
    parsed.lines.forEach((l, n) => putLine({ ...l, id: `${id}-${n + 1}`, tenantId, statementId: id, status: "unmatched", settlementId: null, intentId: null }));
  })();
  P.audit(user.id, "bank_statement", id, "bank_statement.imported", { format: parsed.format, statementId: parsed.statementId, lines: parsed.lines.length });
  return { ...rec, lines: parsed.lines.length, matched: autoMatch(tenantId) };
}

export function statementView(tenantId: string) {
  const lines = linesOf(tenantId);
  const statements = (sql.prepare("SELECT data FROM bank_statements WHERE tenant_id = ? ORDER BY rowid DESC").all(tenantId) as any[]).map((r) => JSON.parse(r.data));
  return { statements, lines, exceptions: lines.filter((l) => l.status === "unmatched"), matched: lines.filter((l) => l.status === "matched").length };
}

function openLine(tenantId: string, lineId: string) {
  const l = getLine(tenantId, lineId);
  if (l.status !== "unmatched") throw err(409, "This line is already closed");
  if (l.pendingChangeId && P.getChange(l.pendingChangeId)?.status === "pending") throw err(409, "This line already waits for a second approver");
  return l;
}

/** Checks a manual match. Amount, currency and direction must agree unless override is set with a note. Returns the amount difference. */
function checkMatch(tenantId: string, l: Line, settlementId: string, note: string, override: boolean) {
  const hit = openSettlements(tenantId).find((x) => x.s.id === settlementId);
  if (!hit) throw err(422, "Pick a settled payment of this client that is not matched yet");
  const pi = hit.pi!;
  if (l.direction !== "debit") throw err(422, "Only a debit line can match an outgoing payment");
  if (pi.currency !== l.currency) throw err(422, `The line is in ${l.currency} but the payment is in ${pi.currency}`);
  const difference = r2(l.amount - r2(pi.amount));
  if (difference !== 0) {
    if (!override) throw err(422, `The line amount ${l.amount} does not equal the payment amount ${r2(pi.amount)}. Tick override and give a note to match anyway.`);
    if (!note.trim()) throw err(422, "Give a note to match with a different amount");
  }
  return { hit, difference: difference || null };
}

/** Asks for a manual match. A second user with the client admin role must approve it. */
export function matchLine(user: P.User, tenantId: string, lineId: string, settlementId: string, note: string, override = false) {
  const l = openLine(tenantId, lineId); const n = String(note ?? "").slice(0, 500);
  const { difference } = checkMatch(tenantId, l, settlementId, n, override);
  const c = P.requestChange(user, "statement.line_resolve", { tenantId, lineId, action: "manual_match", settlementId, note: n, override: !!override, difference, requestedBy: user.id }, tenantId);
  putLine({ ...l, pendingChangeId: c.id }); return c;
}

/** Asks to ignore a line. A second user with the client admin role must approve it. */
export function ignoreLine(user: P.User, tenantId: string, lineId: string, reason: string) {
  const l = openLine(tenantId, lineId);
  const why = String(reason ?? "").trim(); if (!why) throw err(422, "Give a reason to ignore this line");
  const c = P.requestChange(user, "statement.line_resolve", { tenantId, lineId, action: "ignore", note: why.slice(0, 500), requestedBy: user.id }, tenantId);
  putLine({ ...l, pendingChangeId: c.id }); return c;
}

P.registerChangeKind("statement.line_resolve", {
  role: "client_admin",
  validate: (p) => { const l = getLine(p.tenantId, p.lineId); if (l.status !== "unmatched") throw err(409, "This line is already closed"); if (p.action === "manual_match") checkMatch(p.tenantId, l, p.settlementId, p.note ?? "", !!p.override); else if (p.action !== "ignore") throw err(422, "Unknown line action"); },
  apply: (p) => {
    const l = getLine(p.tenantId, p.lineId); const at = now();
    if (p.action === "ignore") {
      const out: Line = { ...l, status: "ignored", pendingChangeId: null, resolution: { action: "ignore", note: p.note, by: p.requestedBy, at } };
      putLine(out); P.audit(p.requestedBy, "bank_statement", l.id, "bank_statement.line_ignored", { reason: p.note }); return out;
    }
    const { hit, difference } = checkMatch(p.tenantId, l, p.settlementId, p.note ?? "", !!p.override);
    const out: Line = { ...l, status: "matched", settlementId: p.settlementId, intentId: hit.pi!.id, pendingChangeId: null, resolution: { action: "manual_match", note: p.note, by: p.requestedBy, at, difference } };
    putLine(out); P.audit(p.requestedBy, "bank_statement", l.id, "bank_statement.line_matched", { settlementId: p.settlementId, auto: false, note: p.note, override: !!p.override, difference }); return out;
  },
});

/** Settled payments with no statement line yet, offered as manual match targets. */
export const matchTargets = (tenantId: string) => openSettlements(tenantId).map(({ s, pi }) => ({ settlementId: s.id, intentId: pi!.id, amount: pi!.amount, currency: pi!.currency, confirmedAt: s.confirmedAt }));
