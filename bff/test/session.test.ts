import { describe, it, expect, beforeEach } from "vitest";
import { useDb } from "../src/db.js";
import { reset, reload } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import { buildApp } from "../src/server.js";

beforeEach(() => { useDb(":memory:"); reload(); reset(); S.bootstrap(); P.seedPlatform(); });

describe("GET /session", () => {
  it("answers 200 with me: null when signed out, so the login page logs no 401", async () => {
    const app = await buildApp();
    const r = await app.inject({ url: "/session" });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ me: null });
    expect((await app.inject({ url: "/me" })).statusCode).toBe(401);
  });
  it("returns the same body as /me once signed in", async () => {
    const app = await buildApp();
    const users = (await app.inject({ url: "/auth/demo-users" })).json();
    const id = (Array.isArray(users) ? users : users.users)[0].id;
    const c = (await app.inject({ method: "POST", url: "/auth/login", payload: { userId: id } })).cookies.find((x: any) => x.name === "sid")!;
    const cookie = `sid=${c.value}`;
    const s = (await app.inject({ url: "/session", headers: { cookie } })).json();
    const me = (await app.inject({ url: "/me", headers: { cookie } })).json();
    expect(s.me).toEqual(me);
  });
});
