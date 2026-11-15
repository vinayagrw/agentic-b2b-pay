import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp, isReady, setReady } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); });
describe("readiness", () => {
  it("returns 503 until seeding is done, then 200 without sign in", async () => {
    const app = await buildApp();
    expect(isReady()).toBe(true);
    setReady(false);
    const a = await app.inject({ method: "GET", url: "/ready" });
    expect(a.statusCode).toBe(503);
    setReady(true);
    const b = await app.inject({ method: "GET", url: "/ready" });
    expect(b.statusCode).toBe(200); expect(b.json().ready).toBe(true);
  });
});
