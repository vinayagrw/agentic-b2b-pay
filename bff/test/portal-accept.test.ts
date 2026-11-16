import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import { installFakes } from "./fakeRail.js";
import * as S from "../src/service.js";
import * as SP from "../src/sparky.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); installFakes(); P.seedPlatform(); S.bootstrap(); SP.resetMcpRate(); SP.resetPortalRate(); });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };

/** A small order sent in through the supplier portal priced 20% over the PO, matched into an exception. */
async function portalException(app: any) {
  const po = S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-BRG-6204", description: "Bearing", qty: 2, unitPrice: 4.25 }], justification: "Spare" });
  expect(po.status).toBe("approved");
  const jane = await login(app, "usr-cfo-jane");
  const token = (await app.inject({ method: "POST", url: "/workspace/suppliers/sup-northwind/portal-link", headers: { cookie: jane } })).json().token;
  const text = S.invoiceText(po.id, { priceBumpPct: 20 });
  const r = await app.inject({ method: "POST", url: `/supplier-portal/${token}/invoices`, payload: { poId: po.id, text } });
  expect(r.statusCode).toBe(200);
  const inv = db.invoices.find((i) => i.id === r.json().invoiceId)!;
  await S.ensureRates({ currency: "USD", tenantId: "tnt-acme" });
  S.matchInvoice(inv.id);
  expect(inv.matchStatus).toBe("exception");
  expect((inv as any).submittedBy).toBe("supplier-portal:sup-northwind");
  return inv;
}

describe("accept with reason on a supplier portal invoice", () => {
  it("lets an approver accept it, and records who, when and why", async () => {
    const app = await buildApp(); const inv = await portalException(app); const sam = await login(app, "usr-controller-sam");
    const r = await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "Price rise agreed by phone" } });
    expect(r.statusCode).toBe(200);
    expect(inv.matchStatus).toBe("matched");
    expect(inv.override).toMatchObject({ by: "usr-controller-sam", reason: "Price rise agreed by phone" });
    expect(Number.isNaN(Date.parse((inv.override as any).at))).toBe(false);
    expect(db.evidence.some((e: any) => e.subjectId === inv.id && e.event === "invoice.match_overridden")).toBe(true);
  });
  it("refuses an empty reason and leaves the exception in place", async () => {
    const app = await buildApp(); const inv = await portalException(app); const sam = await login(app, "usr-controller-sam");
    const r = await app.inject({ method: "POST", url: `/invoices/${inv.id}/override`, headers: { cookie: sam }, payload: { reason: "" } });
    expect(r.statusCode).toBe(422);
    expect(inv.matchStatus).toBe("exception"); expect(inv.override).toBeFalsy();
  });
});
