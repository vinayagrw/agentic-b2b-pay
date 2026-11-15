import crypto from "node:crypto";
import { sql } from "./db.js";
import { db, tenantOf } from "./modules/store.js";
import * as S from "./service.js";
import * as P from "./platform.js";

/** Bank statement import (camt.053 XML and MT940 text) and matching of statement lines to settled payments. Sandbox only. */
export type StmtLine = { amount: number; currency: string; direction: "debit" | "credit"; valueDate: string; endToEndId: string | null; bankRef: string | null; info: string | null };
export type Parsed = { format: "camt053" | "mt940"; statementId: string; lines: StmtLine[] };
export type Line = StmtLine & { id: string; tenantId: string; statementId: string; status: "unmatched" | "matched" | "ignored"; settlementId: string | null; intentId: string | null; resolution?: { action: string; note: string; by: string; at: string } };

const err = (s: number, m: string) => new S.HttpError(s, m);
const now = () => new Date().toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;
const ref = (x: string | null | undefined) => { const v = (x ?? "").trim(); return !v || /^(NOTPROVIDED|NONREF)$/i.test(v) ? null : v; };
const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;
const unesc = (s: string | null) => s && s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function parseCamt(xml: string): Parsed {
  const stmt = tag(xml, "Stmt"); if (!stmt) throw err(422, "camt.053 file has no Stmt block");
  const lines = [...stmt.matchAll(/<Ntry>([\s\S]*?)<\/Ntry>/g)].map(([, n]) => {
    const amt = n.match(/<Amt\s+Ccy="([A-Z]{3})">([\d.]+)<\/Amt>/); if (!amt) throw err(422, "camt.053 entry has no amount");
    const vd = tag(tag(n, "ValDt") ?? "", "Dt") ?? tag(tag(n, "BookgDt") ?? "", "Dt");
    if (!vd) throw err(422, "camt.053 entry has no value date");
    return { amount: r2(Number(amt[2])), currency: amt[1], direction: tag(n, "CdtDbtInd") === "CRDT" ? "credit" as const : "debit" as const, valueDate: vd.slice(0, 10), endToEndId: ref(unesc(tag(n, "EndToEndId"))), bankRef: ref(unesc(tag(n, "AcctSvcrRef"))), info: unesc(tag(n, "AddtlTxInf")) ?? unesc(tag(n, "AddtlNtryInf")) };
  });
  return { format: "camt053", statementId: unesc(tag(stmt, "Id")) ?? "unknown", lines };
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
  return { format: "mt940", statementId: get("20") ?? "unknown", lines };
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
  const dup = sql.prepare("SELECT id FROM bank_statements WHERE tenant_id = ? AND (hash = ? OR json_extract(data, '$.statementId') = ?)").get(tenantId, hash, parsed.statementId) as any;
  if (dup) throw err(409, `This statement was already imported as ${dup.id}`);
  const id = `bst-${crypto.randomUUID().slice(0, 8)}`;
  const rec = { id, tenantId, filename: String(filename || "statement").slice(0, 120), format: parsed.format, statementId: parsed.statementId, lineCount: parsed.lines.length, importedBy: user.id, importedAt: now() };
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

export function matchLine(user: P.User, tenantId: string, lineId: string, settlementId: string, note: string) {
  const l = getLine(tenantId, lineId);
  if (l.status !== "unmatched") throw err(409, "This line is already closed");
  const hit = openSettlements(tenantId).find((x) => x.s.id === settlementId);
  if (!hit) throw err(422, "Pick a settled payment of this client that is not matched yet");
  const out: Line = { ...l, status: "matched", settlementId, intentId: hit.pi!.id, resolution: { action: "manual_match", note: String(note ?? "").slice(0, 500), by: user.id, at: now() } };
  putLine(out); P.audit(user.id, "bank_statement", l.id, "bank_statement.line_matched", { settlementId, auto: false, note: out.resolution!.note });
  return out;
}

export function ignoreLine(user: P.User, tenantId: string, lineId: string, reason: string) {
  const l = getLine(tenantId, lineId);
  if (l.status !== "unmatched") throw err(409, "This line is already closed");
  const why = String(reason ?? "").trim(); if (!why) throw err(422, "Give a reason to ignore this line");
  const out: Line = { ...l, status: "ignored", resolution: { action: "ignore", note: why.slice(0, 500), by: user.id, at: now() } };
  putLine(out); P.audit(user.id, "bank_statement", l.id, "bank_statement.line_ignored", { reason: out.resolution!.note });
  return out;
}

/** Settled payments with no statement line yet, offered as manual match targets. */
export const matchTargets = (tenantId: string) => openSettlements(tenantId).map(({ s, pi }) => ({ settlementId: s.id, intentId: pi!.id, amount: pi!.amount, currency: pi!.currency, confirmedAt: s.confirmedAt }));
