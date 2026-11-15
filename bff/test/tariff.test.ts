import { describe, it, expect, beforeEach } from "vitest";
import { addDays, PoLine, landedCost, dutyDue, TARIFF_NOTE, TARIFF_DEFAULT_DATE } from "@b2b/shared";
import { reset, db, reload, save } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as CP from "../src/copilot.js";
import * as P from "../src/platform.js";
import * as TF from "../src/tariff.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); });
const today = () => new Date().toISOString().slice(0, 10);
const ctx = (id: string, scope: string | null, extra: Partial<CP.Ctx> = {}): CP.Ctx => ({ user: P.getUser(id)!, scope, prefix: scope ? "/app" : "/operator", ...extra });
const jane = () => ctx("usr-cfo-jane", "tnt-acme");
const globexUser = () => P.listUsers().find((u) => u.tenantId === "tnt-globex")!;
/** Drops the seeded duty orders so a test owns every duty line. */
const noSeed = () => { db.pos = db.pos.filter((p) => !p.id.startsWith("po-duty-seed")); };
/** An Acme order with one excluded line (25 percent of 1000) and one plain line (10 percent of 500). */
const dutyPo = (entry: string, tenantId = "tnt-acme") => {
  const base = db.pos.find((p) => p.id === "po-eu-seed")!;
  const po = { ...base, id: `po-t-${db.pos.length}`, tenantId, currency: "USD" as const, total: 1500, usdEquivalent: 1500, status: "approved" as const,
    lines: [{ sku: "A", description: "Excluded part", qty: 10, unitPrice: 100, hsCode: "8501.52", originCountry: "CN", dutyRatePct: 25, customsEntryDate: entry, exclusionApplies: true, exclusionEndDate: entry },
      { sku: "B", description: "Plain part", qty: 5, unitPrice: 100, hsCode: "7326.90", originCountry: "CN", dutyRatePct: 10, customsEntryDate: entry, exclusionApplies: false }] };
  db.pos.push(po); return po;
};
const run = (c: CP.Ctx, after?: string) => CP.runTool(c, "tariffScenario", after ? { after } : {});
const total = (rows: any[], k: string) => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;

describe("duty fields on PO lines", () => {
  it("accepts the optional duty fields and still accepts a line without them", () => {
    expect(PoLine.safeParse({ sku: "A", description: "x", qty: 1, unitPrice: 2 }).success).toBe(true);
    const full = PoLine.safeParse({ sku: "A", description: "x", qty: 1, unitPrice: 2, hsCode: "8501.52", originCountry: "CN", dutyRatePct: 25, customsEntryDate: "2027-01-10", exclusionApplies: true, exclusionEndDate: "2027-01-09" });
    expect(full.success).toBe(true);
    expect(PoLine.safeParse({ sku: "A", description: "x", qty: 1, unitPrice: 2, dutyRatePct: -1 }).success).toBe(false);
    expect(PoLine.safeParse({ sku: "A", description: "x", qty: 1, unitPrice: 2, customsEntryDate: "soon" }).success).toBe(false);
  });
  it("works out duty and landed cost from the rate the user typed in", () => {
    const l = { sku: "A", description: "x", qty: 10, unitPrice: 100, dutyRatePct: 25, customsEntryDate: "2027-01-10", exclusionApplies: true, exclusionEndDate: "2027-01-09" };
    expect(dutyDue(l)).toBe(250); expect(dutyDue({ ...l, customsEntryDate: "2027-01-09" })).toBe(0);
    expect(landedCost([l, { sku: "B", description: "y", qty: 1, unitPrice: 50 }])).toEqual({ goods: 1050, duty: 250, landed: 1300, hasDuty: true });
    expect(landedCost([{ sku: "B", description: "y", qty: 1, unitPrice: 50 }]).hasDuty).toBe(false);
  });
  it("seeds two demo orders with duty fields and tops them up in an older database", () => {
    const seeded = db.pos.filter((p) => p.id.startsWith("po-duty-seed"));
    expect(seeded).toHaveLength(2);
    for (const p of seeded) { expect(p.tenantId).toBe("tnt-acme"); for (const l of p.lines) { expect(PoLine.safeParse(l).success).toBe(true); expect(l.hsCode).toBeTruthy(); expect(typeof l.dutyRatePct).toBe("number"); } }
    noSeed(); save(); expect(reload().pos.filter((p) => p.id.startsWith("po-duty-seed"))).toHaveLength(2);
  });
});

describe("cash forecast", () => {
  it("covers 12 weeks", () => {
    const r = CP.runTool(jane(), "cashForecast"); const rows = r.rows as any[];
    expect(rows).toHaveLength(12); expect(rows[11].week).toBe("Week 12"); expect(rows[11].from).toBe(addDays(today(), 77)); expect(r.summary).toMatch(/12 weeks/);
  });
});

describe("tariffScenario tool", () => {
  it("gives weekly cash out with and without exclusions, and the totals differ by the excluded duty", () => {
    noSeed(); const entry = addDays(today(), 30); dutyPo(entry);
    const r = run(jane(), addDays(entry, -1)); const rows = r.rows as any[];
    expect(r.error).toBeUndefined(); expect(rows).toHaveLength(12);
    const base = total(CP.runTool(jane(), "cashForecast").rows as any[], "outflow");
    expect(total(rows, "dutyWithExclusions")).toBe(50); expect(total(rows, "dutyWithoutExclusions")).toBe(300); expect(total(rows, "extraDuty")).toBe(250);
    expect(total(rows, "cashOutWithExclusions")).toBe(base + 50); expect(total(rows, "cashOutWithoutExclusions")).toBe(base + 300);
    const w = rows[4]; expect(w.from <= entry && entry < addDays(w.from, 7)).toBe(true); expect(w.extraDuty).toBe(250); expect(w.cashOutWithoutExclusions - w.cashOutWithExclusions).toBe(250);
    expect(rows.filter((x) => x.extraDuty).length).toBe(1);
    expect(r.summary).toContain(TARIFF_NOTE); expect(r.summary).toMatch(/\$300\.00/);
    expect(r.chart).toEqual({ type: "line", title: "Weekly cash out with and without exclusions", x: "week", y: ["cashOutWithExclusions", "cashOutWithoutExclusions"] });
    expect(r.source.ids).toEqual([db.pos[db.pos.length - 1].id]);
  });
  it("keeps the exclusion for an entry on the chosen date and ends it the day after", () => {
    noSeed(); const entry = addDays(today(), 20); dutyPo(entry);
    expect(total(run(jane(), entry).rows as any[], "extraDuty")).toBe(0);
    expect(total(run(jane(), addDays(entry, 1)).rows as any[], "extraDuty")).toBe(0);
    expect(total(run(jane(), addDays(entry, -1)).rows as any[], "extraDuty")).toBe(250);
  });
  it("uses 9 Jan 2027 when no date is given and rejects a bad date", () => {
    expect(TARIFF_DEFAULT_DATE).toBe("2027-01-09");
    const sc = TF.scenario("tnt-acme", (CP.runTool(jane(), "cashForecast").rows as any[]), undefined, "2026-11-14");
    expect(sc.after).toBe("2027-01-09");
    // Seeded lines: entry 18 Dec stays excluded. Entries on 15 and 22 Jan lose the exclusion: 4 x 420 x 25 percent plus 100 x 18 x 10 percent.
    expect(sc.totals.extraDuty).toBe(600); expect(sc.totals.dutyWithExclusions).toBe(90); expect(sc.totals.dutyWithoutExclusions).toBe(690);
    expect(run(jane()).summary).toMatch(/Scenario date 2027-01-09|No purchase order line/);
    expect(run(jane(), "9 Jan").error).toMatch(/date like 2027-01-09/); expect(run(jane(), "2027-02-31").error).toMatch(/date like 2027-01-09/);
  });
  it("leaves out lines with customs entry after week 12 and says so", () => {
    noSeed(); dutyPo(addDays(today(), 100));
    const r = run(jane(), today()); expect(total(r.rows as any[], "dutyWithoutExclusions")).toBe(0); expect(r.summary).toMatch(/after week 12 not counted/);
  });
  it("never shows another tenant's duty lines", () => {
    noSeed(); const entry = addDays(today(), 30); const po = dutyPo(entry, "tnt-acme");
    const g = run(ctx(globexUser().id, "tnt-globex"), addDays(entry, -1));
    expect(g.error).toBeUndefined(); expect(total(g.rows as any[], "dutyWithoutExclusions")).toBe(0); expect(g.source.ids).not.toContain(po.id); expect(g.summary).toMatch(/No purchase order line has a duty rate/);
    expect(TF.dutyLines("tnt-globex", addDays(entry, -1), today())).toEqual([]);
    expect(() => run(ctx("usr-cfo-jane", "tnt-globex"), addDays(entry, -1))).toThrow();
    const gp = dutyPo(entry, "tnt-globex");
    const a = run(jane(), addDays(entry, -1)); expect(total(a.rows as any[], "dutyWithoutExclusions")).toBe(300); expect(a.source.ids).toEqual([po.id]); expect(a.source.ids).not.toContain(gp.id);
  });
  it("is planned from a plain question, reads a date in it, and answers with a chart spec", async () => {
    expect(CP.mockPlan("Run the tariff cash scenario after 2027-02-01")).toEqual([{ name: "tariffScenario", args: { after: "2027-02-01" } }]);
    expect(CP.mockPlan("What if duty exclusions end after 9 Jan 2027?")[0]).toEqual({ name: "tariffScenario", args: { after: "2027-01-09" } });
    noSeed(); const entry = addDays(today(), 30); dutyPo(entry);
    const a = await CP.ask(jane(), `Run the tariff cash scenario after ${addDays(entry, -1)}`);
    expect(a.refused).toBeNull(); expect(a.tools[0].tool).toBe("tariffScenario"); expect(a.answer).toContain(TARIFF_NOTE);
    expect(a.chart?.spec?.type).toBe("line"); expect(a.chart?.spec?.y).toEqual(["cashOutWithExclusions", "cashOutWithoutExclusions"]); expect(a.chart?.spec?.rows).toHaveLength(12);
  });
  it("ships as a skill that only lists known tools", () => {
    const sk = CP.skills().find((s) => s.slug === "tariff-cash-scenario")!;
    expect(sk.tools.map((t) => t.name)).toEqual(["tariffScenario", "cashForecast", "entityBalances"]); expect(sk.chart).toBe("line"); expect(sk.body).toContain(TARIFF_NOTE);
    expect(CP.skillPlan(sk, "after 2027-02-01")[0]).toEqual({ name: "tariffScenario", args: { after: "2027-02-01" } });
  });
});
