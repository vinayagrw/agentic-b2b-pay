import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { QueryClient } from "@tanstack/query-core";
import { useDb, migrate } from "../src/db.js";
import { db, reload, reset } from "../src/modules/store.js";
import * as P from "../src/platform.js";
import * as S from "../src/service.js";
import { railReadiness, setAdapters } from "../src/rails/index.js";
import { stripeCard, stripeAch } from "../src/rails/stripe.js";
import { routePayment } from "../src/modules/router.js";
import { afterLogin } from "../../web/src/lib/session.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });

describe("bug 1: one source of truth for rail configured", () => {
  it("router candidates, Rails table and readiness agree, and a key set after start is seen by all", () => {
    setAdapters({ stripe_card: stripeCard, stripe_ach: stripeAch });
    const prev = process.env.STRIPE_SECRET_KEY;
    try {
      delete process.env.STRIPE_SECRET_KEY;
      expect(railReadiness("stripe_card", "sandbox").configured).toBe(false);
      process.env.STRIPE_SECRET_KEY = "sk_test_regression";
      const table = S.railsView("tnt-acme").filter((r) => r.rail.startsWith("stripe"));
      const cands = S.railCandidates("tnt-acme", 8.5).filter((r) => r.rail.startsWith("stripe"));
      expect(table.every((r) => r.configured)).toBe(true);
      expect(cands.map((c) => [c.rail, c.configured])).toEqual(table.map((r) => [r.rail, r.configured]));
      const d = routePayment({ amount: 8.5, urgency: "standard", mandateRails: ["stripe_card", "stripe_ach"], supplierRails: ["stripe_card", "stripe_ach"], supplierPreferred: "stripe_ach", supplierHasWallet: false, supplierScreening: "clear", supplierCountry: "US", candidates: S.railCandidates("tnt-acme", 8.5) });
      for (const o of d.options.filter((o) => o.rail.startsWith("stripe"))) expect(o.why.join(" ")).not.toMatch(/Not configured/);
    } finally { if (prev === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prev; }
  });
});

describe("bug 2: legacy simulated payments", () => {
  it("migration 006 removes old rail rows and fake receipts, keeps real ones, unpays the invoice", () => {
    const d = new Database(":memory:");
    const dir = path.resolve(__dirname, "../migrations");
    d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql") && x < "006").sort()) { d.exec(fs.readFileSync(path.join(dir, f), "utf8")); d.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(f, "x"); }
    const ins = (t: string, cols: string[], vals: unknown[]) => d.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
    ins("payment_intents", ["id", "tenant_id", "status", "data"], ["pi-1007", "tnt-acme", "settled", JSON.stringify({ id: "pi-1007", invoiceId: "inv-1", route: { rail: "usdc", options: [] }, rail: "usdc" })]);
    ins("payment_intents", ["id", "tenant_id", "status", "data"], ["pi-2000", "tnt-acme", "failed", JSON.stringify({ id: "pi-2000", invoiceId: "inv-2", route: { rail: "onchain_usdc", options: [{ rail: "stripe_ach" }] }, rail: "onchain_usdc" })]);
    ins("rail_events", ["id", "tenant_id", "intent_id", "kind", "data"], ["stl-1008", "tnt-acme", "pi-1007", "confirmed", JSON.stringify({ rail: "onchain_usdc", chain: "base-sim", railRef: "USDC-ABC" })]);
    ins("journals", ["id", "tenant_id", "data"], ["jnl-1", "tnt-acme", JSON.stringify({ ref: "pi-1007", memo: "Payment INV-1 via usdc" })]);
    migrate(d);
    expect(d.prepare("SELECT id FROM payment_intents").all()).toEqual([{ id: "pi-2000" }]);
    expect(d.prepare("SELECT count(*) n FROM rail_events").get()).toEqual({ n: 0 });
    expect(d.prepare("SELECT count(*) n FROM journals").get()).toEqual({ n: 0 });
  });
  it("reset and seed start with empty payment history", () => {
    reset(); S.bootstrap();
    expect(db.intents).toEqual([]); expect(db.settlements).toEqual([]); expect(db.journals).toEqual([]);
    expect(db.invoices.some((i) => i.paid)).toBe(false);
  });
  it("seeded Northwind accepts card and ACH and the demo bearing pair is under 10 USD", () => {
    const nw = db.suppliers.find((s) => s.id === "sup-northwind")!;
    expect(nw.acceptedRails).toEqual(expect.arrayContaining(["stripe_card", "stripe_ach", "onchain_usdc"]));
    expect(2 * db.catalog.find((c) => c.sku === "NW-BRG-6204")!.unitPrice).toBe(8.5);
  });
});

describe("bug 3: no simulated compliance output", () => {
  it("payment compliance has real refs and no sim text", async () => {
    const r = await S.runFlow("Need 2 sealed 6204 bearings for line 3");
    const pi = db.intents.find((i) => i.id === (r as any).intentId) ?? db.intents.at(-1)!;
    const text = JSON.stringify(pi.compliance);
    expect(text).not.toMatch(/sim-|simulated/i);
    expect(pi.compliance!.checks.find((c) => c.kind === "kyb")!.result).toBe("pass");
    expect(pi.compliance!.checks.find((c) => c.kind === "sanctions")!.providerRef).toMatch(/^ofac-sdn-/);
  });
});

describe("bug 4: login lands on the right page", () => {
  it("refetches the cached null /me and navigates by role", async () => {
    for (const [me, want] of [[{ operator: false }, "/app"], [{ operator: true }, "/operator"]] as const) {
      const qc = new QueryClient(); qc.setQueryData(["me"], null);
      const navs: string[] = [];
      const to = await afterLogin(qc as any, async () => me, (p) => navs.push(p));
      expect(to).toBe(want); expect(navs).toEqual([want]); expect(qc.getQueryData(["me"])).toEqual(me);
    }
  });
});

import { routePayment } from "../src/modules/router.js";
describe("router skips a prefunded wallet that cannot cover the payment", () => {
  it("falls back to ACH when the onchain wallet is empty", () => {
    const base = { feeUsd: 0, maxAmount: 1e9, configured: true } as const;
    const d = routePayment({ amount: 8.5, urgency: "standard", mandateRails: ["stripe_ach", "onchain_usdc"], supplierRails: ["stripe_ach", "onchain_usdc"], supplierPreferred: "onchain_usdc", supplierHasWallet: true, supplierScreening: "clear", supplierCountry: "US",
      candidates: [{ ...base, rail: "onchain_usdc", label: "o", settleMinutes: 1, available: 0 }, { ...base, rail: "stripe_ach", label: "a", settleMinutes: 5760 }] as any });
    expect(d.rail).toBe("stripe_ach");
  });
});
