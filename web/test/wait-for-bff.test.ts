import { describe, expect, it } from "vitest";
import net from "node:net";
import { waitForBff } from "../dev/waitForBff";

const freePort = () => new Promise<number>((ok) => { const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });
const fakeRes = () => { const r: any = { headers: {} as Record<string, string>, statusCode: 0, body: "", setHeader(k: string, v: string) { r.headers[k] = v; }, end(b?: string) { r.body = b ?? ""; r.ended = true; } }; return r; };

describe("dev proxy waits for the bff on restart", () => {
  it("holds an /api request until the bff port opens, then passes it on (no 500)", async () => {
    const port = await freePort(); const mw = waitForBff(port, 3000);
    let srv: net.Server | undefined; setTimeout(() => { srv = net.createServer().listen(port); }, 300);
    const res = fakeRes(); let passed = false;
    await new Promise<void>((done) => mw({ url: "/api/me" }, res, () => { passed = true; done(); }));
    expect(passed).toBe(true); expect(res.ended).toBeFalsy();
    srv?.close();
  });
  it("answers 503 with Retry-After, not 500, if the bff never comes up", async () => {
    const port = await freePort(); const mw = waitForBff(port, 300); const res = fakeRes();
    await new Promise<void>((done) => { res.end = (b?: string) => { res.body = b; done(); }; mw({ url: "/api/me" }, res, () => done()); });
    expect(res.statusCode).toBe(503); expect(res.headers["Retry-After"]).toBe("1");
  });
  it("does not touch non-api requests", async () => {
    const mw = waitForBff(1, 50); let passed = false;
    await new Promise<void>((done) => mw({ url: "/login" }, fakeRes(), () => { passed = true; done(); }));
    expect(passed).toBe(true);
  });
});
