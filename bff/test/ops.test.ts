import { describe, it, expect, beforeEach } from "vitest";
import { useDb, sql } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as W from "../src/workspace.js";
import * as O from "../src/ops.js";
import { csvRows, screenName, screenWallet, normName } from "../src/modules/sdn.js";
import { installFakes } from "./fakeRail.js";

let rails: ReturnType<typeof installFakes>;
beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); rails = installFakes(); W.setBankTokenizer(async (b) => ({ tokenId: "btok_x", last4: b.accountNumber.slice(-4), bankName: null })); });
const op = () => P.getUser("usr-op-olivia")!;

describe("OFAC SDN screening", () => {
  it("parses quoted CSV and digital currency addresses", () => {
    expect(csvRows('1,"A, B","x ""y"""\n2,c,d\n')).toEqual([["1", "A, B", 'x "y"'], ["2", "c", "d"]]);
    expect(screenWallet("0xD00D00000000000000000000000000000000D00D")[0]).toMatchObject({ source: "OFAC SDN", uid: "36001", asset: "ETH" });
  });
  it("matches names, aliases and token order, ignoring company suffixes", () => {
    expect(screenName("Volga Shadow Trading")[0]).toMatchObject({ uid: "36001", matchedOn: "name", score: 100 });
    expect(screenName("Northern Light Metals Ltd")[0]).toMatchObject({ uid: "36001", matchedOn: "alias" });
    expect(screenName("Ivan Krasny")[0]).toMatchObject({ uid: "36002" });
    expect(screenName("Northwind Components LLC")).toEqual([]);
    expect(normName("ACME, Inc.")).toBe("acme");
  });
  it("a blocked payment opens a sanctions case with hits, and the SAR goes draft to filed", async () => {
    const r = await S.runFlow("Need steel", { scenario: "sanctioned" });
    const pi = db.intents.find((i) => i.id === r.intentId)!; expect(pi.status).toBe("blocked");
    const c = S.listCases().find((x) => x.kind === "sanctions")!;
    expect(c.intentId).toBe(pi.id); expect(c.detail.hits[0].source).toBe("Demo watchlist"); expect(c.detail.travelRule.aboveThreshold).toBe(true);
    expect(O.travelRuleRecords("tnt-acme").map((t) => t.intentId)).toContain(pi.id);
    const d = await O.draftSar(op(), c.id);
    expect(d.sar!.status).toBe("draft"); expect(d.sar!.draftedBy).toMatch(/template/); expect(d.sar!.text).toMatch(/Fabrikam/); expect(d.sar!.text).not.toMatch(/[;—]/);
    O.editSar(op(), c.id, d.sar!.text + "\n\nReviewer note: confirmed true match.");
    expect(O.fileSar(op(), c.id).sar!.status).toBe("filed-internally");
    expect(() => O.editSar(op(), c.id, "x")).toThrow(/Filed/);
    expect(O.closeCase(op(), c.id, "Supplier offboarded").status).toBe("closed");
  });
  it("supplier onboarding with an SDN name opens a case and cannot be verified", () => {
    const inv = W.inviteSupplier(P.getUser("usr-clerk-pat")!, "tnt-acme", { name: "Volga", email: "a@b.example" });
    W.saveKyb(inv.token, { legalName: "Volga Shadow Trading LLC", taxIdType: "vat", taxId: "GB123456789", address: { line1: "1 St", city: "London", postalCode: "E1", country: "GB" }, ubos: [{ name: "X Y", ownershipPct: 100, country: "GB" }] });
    return W.saveBank(inv.token, { holderName: "Volga", routingNumber: "110000000", accountNumber: "000123456789" }).then(() => {
      W.submitOnboarding(inv.token);
      expect(S.listCases().some((c) => c.detail.supplierId === inv.supplier.id)).toBe(true);
      expect(() => W.reviewSupplier(P.getUser("usr-cfo-jane")!, "tnt-acme", inv.supplier.id, true)).toThrow(/screening/);
    });
  });
});

describe("treasury", () => {
  it("shows live adapter balances and a 30 day forecast from open invoices", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    const inv = db.invoices.find((i) => i.id === r.invoiceId)!;
    db.intents.find((i) => i.id === r.intentId)!.status = "failed"; inv.paid = false; // keep it open for the forecast
    inv.dueDate = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    const t = await O.treasury("tnt-acme");
    expect(t.balances).toHaveLength(4); expect(t.startingCash).toBe(4000);
    expect(t.forecast).toHaveLength(31); expect(t.forecast[10].outflow).toBe(inv.amount); expect(t.forecast[30].balance).toBe(4000 - inv.amount);
    expect(t.balances.find((b: any) => b.rail === "circle_usdc")!.sweep.supported).toBe(false);
  });
  it("sweeps through the adapter where supported and records unsupported honestly", async () => {
    const un = await O.sweep(op(), "tnt-acme", "circle_usdc", 50);
    expect(un.status).toBe("unsupported");
    rails.circle_usdc.sweep = async (amount) => ({ providerRef: `payout-${amount}`, status: "settled" });
    const ok = await O.sweep(op(), "tnt-acme", "circle_usdc", 50);
    expect(ok).toMatchObject({ status: "settled", providerRef: "payout-50" });
    expect(db.journals.some((j) => j.memo.startsWith("Sweep"))).toBe(true);
    await expect(O.sweep(op(), "tnt-acme", "stripe_card", 5)).rejects.toThrow(/stablecoin/);
    expect(O.listSweeps("tnt-acme")).toHaveLength(2);
  });
});

describe("reconciliation", () => {
  it("matches settled payments to journals and exports CSV and camt.053", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const rec = O.runRecon("tnt-acme"); expect(rec.matched).toBe(1); expect(rec.exceptions).toHaveLength(0);
    expect(O.reconCsv("tnt-acme")).toMatch(new RegExp(`${r.intentId},onchain_usdc`));
    expect(S.camt053(undefined, "tnt-globex")).toMatch(/<NbOfNtries>0</);
  });
  it("opens amount mismatch, unmatched webhook and late exceptions, and resolves them", async () => {
    const r = await S.runFlow("Need 2000 sealed 6204 bearings for line 3"); await S.pollSettlements();
    const j = db.journals.find((x) => x.ref === r.intentId && x.memo.startsWith("Payment"))!; j.entries[0].debit -= 1; j.entries[1].credit -= 1;
    sql.prepare("INSERT INTO provider_events (provider, event_id, type, intent_id, received_at) VALUES ('stripe','evt_orphan','payment_intent.succeeded',NULL,?)").run(new Date().toISOString());
    rails.onchain_usdc.outcome = "pending";
    const r2 = await S.runFlow("Need 2000 sealed 6204 bearings for line 3");
    const rec = O.runRecon("tnt-acme", new Date(Date.now() + 3 * 3600e3));
    expect(rec.exceptions.map((x) => x.kind).sort()).toEqual(["amount_mismatch", "late", "unmatched"]);
    expect(O.runRecon("tnt-acme").opened).toBe(0);
    const mm = rec.exceptions.find((x) => x.kind === "amount_mismatch")!;
    await expect(O.resolveException(op(), "tnt-acme", mm.id, "post_adjustment", "")).rejects.toThrow(/note/);
    const done = await O.resolveException(op(), "tnt-acme", mm.id, "post_adjustment", "Journal short by one dollar");
    expect(done.status).toBe("resolved"); expect(db.journals.find((x) => x.id === done.resolution!.journalId)!.entries[0].debit).toBe(1);
    const late = rec.exceptions.find((x) => x.kind === "late")!;
    await expect(O.resolveException(op(), "tnt-acme", late.id, "recheck", "")).rejects.toThrow(/Still pending/);
    rails.onchain_usdc.outcome = "settled";
    expect((await O.resolveException(op(), "tnt-acme", late.id, "recheck", "")).status).toBe("resolved");
    expect(db.intents.find((i) => i.id === r2.intentId)!.status).toBe("settled");
  });
});
