import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as B from "../src/bankstmt.js";
import { installFakes } from "./fakeRail.js";
import { buildApp } from "../src/server.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/statements");
const fx = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); installFakes(); });
const op = () => P.getUser("usr-op-olivia")!;
const jane = () => P.getUser("usr-cfo-jane")!; const amara = () => P.getUser("usr-acme-amara")!;
const camtFor = (ref: string, amt: number, day: string, id = "STMT-T1") => fx("sample.camt053.xml").replace("STMT-2026-11-01", id).replace("pi-sample-1", ref).replace(">1250.00<", `>${amt.toFixed(2)}<`).replace(/<ValDt><Dt>2026-11-01/, `<ValDt><Dt>${day}`);

describe("bank statement parsing", () => {
  it("parses the camt.053 fixture", () => {
    const s = B.parseStatement(fx("sample.camt053.xml"));
    expect(s.format).toBe("camt053"); expect(s.statementId).toBe("STMT-2026-11-01");
    expect(s.lines).toEqual([
      expect.objectContaining({ amount: 1250, currency: "USD", direction: "debit", valueDate: "2026-11-01", endToEndId: "pi-sample-1", bankRef: "BANKREF-1" }),
      expect.objectContaining({ amount: 75.5, endToEndId: null, info: "Bank fee" }),
    ]);
  });
  it("parses the MT940 fixture", () => {
    const s = B.parseStatement(fx("sample.mt940.txt"));
    expect(s.format).toBe("mt940"); expect(s.statementId).toBe("SANDBOX940-0001");
    expect(s.lines[0]).toMatchObject({ amount: 1250, currency: "USD", direction: "debit", valueDate: "2026-11-01", endToEndId: "pi-sample-1", bankRef: "BANKREF-1", info: "Supplier payment" });
    expect(s.lines[1]).toMatchObject({ amount: 75.5, endToEndId: null });
  });
  it("rejects a file that is neither format", () => { expect(() => B.parseStatement("hello")).toThrow(/camt.053 or MT940/); });
});

describe("bank statement reconciliation", () => {
  it("auto matches a settled payment, rejects a duplicate upload and lists the rest as exceptions", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const pi = db.intents.find((i) => i.id === r.intentId)!; const st = db.settlements.find((s) => s.paymentIntentId === pi.id)!;
    const day = st.confirmedAt.slice(0, 10);
    const content = camtFor(pi.id, pi.amount, day);
    const out = B.importStatement(op(), "tnt-acme", "nov.xml", content);
    expect(out.matched).toBe(1); expect(out.lines).toBe(2);
    expect(() => B.importStatement(op(), "tnt-acme", "again.xml", content)).toThrow(/already imported/);
    const v = B.statementView("tnt-acme");
    expect(v.exceptions).toHaveLength(1); expect(v.exceptions[0].info).toBe("Bank fee");
    expect(v.lines.find((l) => l.status === "matched")!.settlementId).toBe(st.id);
    expect(B.statementView("tnt-globex").lines).toHaveLength(0);
    expect(() => B.ignoreLine(op(), "tnt-acme", v.exceptions[0].id, "")).toThrow(/reason/);
    const c = B.ignoreLine(jane(), "tnt-acme", v.exceptions[0].id, "Monthly bank fee");
    expect(c.status).toBe("pending"); expect(B.statementView("tnt-acme").exceptions).toHaveLength(1);
    expect(() => B.ignoreLine(amara(), "tnt-acme", v.exceptions[0].id, "again")).toThrow(/second approver/);
    expect(() => P.decideChange(jane(), c.id, true)).toThrow(/own change/);
    expect((P.decideChange(amara(), c.id, true).result as any).status).toBe("ignored");
    expect(JSON.stringify(db.evidence)).toMatch(/bank_statement.line_ignored/);
  });
  it("does not auto match when value date is over 2 days off, and allows a manual match", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const pi = db.intents.find((i) => i.id === r.intentId)!; const st = db.settlements.find((s) => s.paymentIntentId === pi.id)!;
    const far = new Date(Date.parse(st.confirmedAt) + 5 * 864e5).toISOString().slice(0, 10);
    expect(B.importStatement(op(), "tnt-acme", "x.xml", camtFor(pi.id, pi.amount, far)).matched).toBe(0);
    const line = B.statementView("tnt-acme").exceptions.find((l) => l.endToEndId === pi.id)!;
    expect(() => B.matchLine(op(), "tnt-acme", line.id, "stl-nope", "x")).toThrow(/settled payment/);
    const c = B.matchLine(op(), "tnt-acme", line.id, st.id, "Bank booked late");
    expect(c.status).toBe("pending");
    expect((P.decideChange(jane(), c.id, true).result as any).status).toBe("matched");
    expect(() => B.matchLine(op(), "tnt-globex", line.id, st.id, "x")).toThrow(/not found/);
  });
  it("rejects a manual match whose amount, currency or direction differ, unless override has a note", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const pi = db.intents.find((i) => i.id === r.intentId)!; const st = db.settlements.find((s) => s.paymentIntentId === pi.id)!;
    const day = st.confirmedAt.slice(0, 10);
    B.importStatement(op(), "tnt-acme", "a.xml", camtFor("other-ref", 10, day, "STMT-A"));
    const small = B.statementView("tnt-acme").exceptions.find((l) => l.amount === 10)!;
    expect(() => B.matchLine(jane(), "tnt-acme", small.id, st.id, "")).toThrow(/does not equal/);
    expect(() => B.matchLine(jane(), "tnt-acme", small.id, st.id, "", true)).toThrow(/note/);
    const c = B.matchLine(jane(), "tnt-acme", small.id, st.id, "Partial booking", true);
    expect(c.payload.difference).toBe(Math.round((10 - pi.amount) * 100) / 100);
    P.decideChange(amara(), c.id, false);
    B.importStatement(op(), "tnt-acme", "b.xml", camtFor("x2", pi.amount, day, "STMT-B").replace("USD\">" + pi.amount.toFixed(2), "EUR\">" + pi.amount.toFixed(2)).replace(/Ccy="USD">([\d.]+)<\/Amt><CdtDbtInd>DBIT/, 'Ccy="EUR">$1</Amt><CdtDbtInd>DBIT'));
    const eur = B.statementView("tnt-acme").exceptions.find((l) => l.currency === "EUR")!;
    expect(() => B.matchLine(jane(), "tnt-acme", eur.id, st.id, "x", true)).toThrow(/EUR/);
    B.importStatement(op(), "tnt-acme", "c.xml", camtFor("x3", pi.amount, day, "STMT-C").replace("<CdtDbtInd>DBIT", "<CdtDbtInd>CRDT"));
    const cr = B.statementView("tnt-acme").exceptions.find((l) => l.direction === "credit")!;
    expect(() => B.matchLine(jane(), "tnt-acme", cr.id, st.id, "x", true)).toThrow(/debit/);
  });
  it("does not treat a missing or reused statement id as a duplicate", () => {
    const mt = fx("sample.mt940.txt");
    B.importStatement(op(), "tnt-acme", "1.txt", mt);
    expect(() => B.importStatement(op(), "tnt-acme", "2.txt", mt.replace(":28C:00001/001", ":28C:00002/001").replace("BANKREF-1", "BANKREF-9"))).not.toThrow();
    expect(() => B.importStatement(op(), "tnt-acme", "3.txt", mt.replace(":28C:00001/001", ":28C:00001/001").replace("Supplier payment", "Other text"))).toThrow(/already imported/);
    const camt = fx("sample.camt053.xml").replace("<Id>STMT-2026-11-01</Id>", "");
    B.importStatement(op(), "tnt-acme", "a.xml", camt);
    expect(() => B.importStatement(op(), "tnt-acme", "b.xml", camt.replace("BANKREF-1", "BANKREF-7"))).not.toThrow();
  });
  it("rejects a camt.053 file with more than one statement", () => {
    const x = fx("sample.camt053.xml"); const stmt = x.match(/<Stmt>[\s\S]*?<\/Stmt>/)![0];
    expect(() => B.parseStatement(x.replace(stmt, stmt + stmt))).toThrow(/more than one statement/);
  });
  it("imports an MT940 file", async () => {
    expect(B.importStatement(op(), "tnt-acme", "s.txt", fx("sample.mt940.txt")).lines).toBe(2);
  });
  it("client admins and operators use the routes, clerks cannot import, duplicates get 409", async () => {
    const app = await buildApp();
    const login = async (userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid")!.value}`; };
    const jane = await login("usr-cfo-jane"); const pat = await login("usr-clerk-pat"); const olivia = await login("usr-op-olivia");
    const payload = { filename: "s.txt", content: fx("sample.mt940.txt") };
    expect((await app.inject({ method: "POST", url: "/reconciliation/statements", headers: { cookie: pat }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/reconciliation/statements", headers: { cookie: jane }, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/reconciliation/statements", headers: { cookie: jane }, payload })).statusCode).toBe(409);
    const v = (await app.inject({ method: "GET", url: "/reconciliation/statements?tenantId=tnt-acme", headers: { cookie: olivia } })).json();
    expect(v.exceptions).toHaveLength(2);
    const ig = await app.inject({ method: "POST", url: `/reconciliation/statements/lines/${v.exceptions[1].id}/ignore?tenantId=tnt-acme`, headers: { cookie: olivia }, payload: { reason: "Bank fee" } });
    expect(ig.json().status).toBe("pending");
    expect((await app.inject({ method: "POST", url: `/changes/${ig.json().id}/decide`, headers: { cookie: jane }, payload: { approve: true } })).json().result.status).toBe("ignored");
    await app.close();
  });
});
