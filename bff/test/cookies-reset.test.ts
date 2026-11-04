import { describe, it, expect, vi } from "vitest";

vi.mock("../src/oidc.js", async (orig) => ({ ...(await orig<any>()), start: async (idp: string) => ({ url: "https://idp.test/authorize", pending: { v: "v", s: "s", n: "n", idp, at: Date.now() } }) }));

const { buildApp } = await import("../src/server.js");
const store = await import("../src/modules/store.js");
const { reset, save, nextId } = store;

describe("OIDC state cookie", () => {
  it("is set with path / so it survives the /api proxy", async () => {
    const app = await buildApp();
    const r = await app.inject({ method: "GET", url: "/auth/oidc/start?idp=idp-x" });
    expect(r.statusCode).toBe(302);
    const c = r.cookies.find((x) => x.name === "oidc");
    expect(c?.path).toBe("/");
    expect(c?.httpOnly).toBe(true);
  });
});

describe("reset", () => {
  it("drops suppliers and orgs added at runtime and gives clean seed data", () => {
    reset(); let db = store.db;
    const before = { s: db.suppliers.length, o: db.orgs.length };
    const orgId = nextId("org"); db.orgs.push({ id: orgId, legalName: "Contoso Metals", type: "supplier", kybStatus: "pending", country: "US" } as any);
    db.suppliers.push({ ...db.suppliers[0], id: nextId("sup"), orgId, name: "Contoso Metals" }); save();
    reset(); db = store.db;
    expect(JSON.stringify(db)).not.toContain("Contoso Metals");
    expect({ s: db.suppliers.length, o: db.orgs.length }).toEqual(before);
  });
});
