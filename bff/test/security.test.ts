import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { signSamlPost } from "@node-saml/node-saml/lib/saml-post-signing.js";
import { useDb } from "../src/db.js";
import { reset, reload, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as P from "../src/platform.js";
import * as SAML from "../src/saml.js";
import * as SU from "../src/stepup.js";
import * as KYA from "../src/modules/kya.js";
import * as AP2 from "../src/modules/ap2.js";
import { buildApp } from "../src/server.js";
import { stepUp } from "./helpers/security.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const KEY = fs.readFileSync(path.join(FIX, "saml-idp-test.key"), "utf8");
const CERT = fs.readFileSync(path.join(FIX, "saml-idp-test.crt"), "utf8");
const IDP = "https://test-idp.invalid/realms/b2bpay";
beforeEach(() => { useDb(":memory:"); reload(); reset(); P.seedPlatform(); S.bootstrap(); SAML.configure({ ssoUrl: `${IDP}/protocol/saml`, idpIssuer: IDP, cert: CERT }); });
afterEach(() => { SAML.configure(null); for (const k of ["RATE_LIMIT_SESSION_MAX", "RATE_LIMIT_KEY_MAX", "RATE_LIMIT_IP_MAX"]) delete process.env[k]; });
const login = async (app: any, userId: string) => { const r = await app.inject({ method: "POST", url: "/auth/login", payload: { userId } }); expect(r.statusCode).toBe(200); return `sid=${r.cookies.find((x: any) => x.name === "sid").value}`; };
const bigPo = (qty = 30) => S.createPo({ supplierId: "sup-northwind", category: "components", currency: "USD", lines: [{ sku: "NW-MTR-750", description: "Servo", qty, unitPrice: 420 }], justification: "Line 4 retrofit" });

/** A SAML response from the fixture IdP. The assertion and the response are each signed with the test key. */
function samlResponse(o: { inResponseTo: string; email?: string; tenant?: string; groups?: string[]; key?: string; audience?: string }) {
  const now = new Date(), later = new Date(now.getTime() + 5 * 60_000), id = `_${crypto.randomUUID()}`, aid = `_${crypto.randomUUID()}`;
  const iso = (d: Date) => d.toISOString(); const email = o.email ?? "sam@acme.demo";
  const attr = (n: string, vs: string[]) => `<saml:Attribute Name="${n}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${vs.map((v) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${v}</saml:AttributeValue>`).join("")}</saml:Attribute>`;
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(now)}" Destination="${SAML.acsUrl()}" InResponseTo="${o.inResponseTo}"><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
    + `<saml:Assertion ID="${aid}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${IDP}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" NotOnOrAfter="${iso(later)}" Recipient="${SAML.acsUrl()}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 30_000))}" NotOnOrAfter="${iso(later)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SAML.spEntityId()}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attr("email", [email])}${attr("tenant", [o.tenant ?? "tnt-acme"])}${attr("groups", o.groups ?? ["approver"])}${attr("firstName", ["Sam"])}${attr("lastName", ["Rivera"])}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  const opts = { privateKey: o.key ?? KEY, signatureAlgorithm: "sha256" as const, digestAlgorithm: "sha256" };
  const a = signSamlPost(xml, "/*[local-name(.)='Response']/*[local-name(.)='Assertion']", opts);
  return Buffer.from(signSamlPost(a, "/*[local-name(.)='Response']", opts)).toString("base64");
}
/** Starts a SAML sign in and returns the AuthnRequest ID the SP expects back. */
async function startSaml(app: any) {
  const r = await app.inject({ url: "/auth/saml/start" }); expect(r.statusCode).toBe(302);
  const req = new URL(r.headers.location).searchParams.get("SAMLRequest")!;
  return /ID="([^"]+)"/.exec(zlib.inflateRawSync(Buffer.from(req, "base64")).toString("utf8"))![1];
}
const post = (app: any, SAMLResponse: string) => app.inject({ method: "POST", url: "/auth/saml/acs", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ SAMLResponse }).toString() });

describe("SAML 2.0 sign in", () => {
  it("accepts a signed assertion, maps attributes to tenant and role and opens a session", async () => {
    const app = await buildApp();
    expect((await app.inject({ url: "/auth/config" })).json().saml.available).toBe(true);
    const r = await post(app, samlResponse({ inResponseTo: await startSaml(app) }));
    expect(r.statusCode).toBe(302); expect(r.headers.location).not.toMatch(/error/);
    const sid = r.cookies.find((c: any) => c.name === "sid"); expect(sid).toBeTruthy();
    const me = (await app.inject({ url: "/me", headers: { cookie: `sid=${sid!.value}` } })).json();
    expect(me.user).toMatchObject({ email: "sam@acme.demo", tenantId: "tnt-acme", role: "approver" });
  });
  it("rejects a response signed by another key, a replay, a wrong audience and an unmapped group", async () => {
    const app = await buildApp();
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bad = await post(app, samlResponse({ inResponseTo: await startSaml(app), key: other }));
    expect(bad.headers.location).toMatch(/error=/); expect(bad.cookies.find((c: any) => c.name === "sid")).toBeUndefined();
    const id = await startSaml(app); const ok = samlResponse({ inResponseTo: id });
    expect((await post(app, ok)).cookies.find((c: any) => c.name === "sid")).toBeTruthy();
    expect((await post(app, ok)).headers.location).toMatch(/error=/);
    expect((await post(app, samlResponse({ inResponseTo: await startSaml(app), audience: "someone-else" }))).headers.location).toMatch(/error=/);
    expect((await post(app, samlResponse({ inResponseTo: "_never-issued" }))).headers.location).toMatch(/error=/);
    const nog = await post(app, samlResponse({ inResponseTo: await startSaml(app), groups: ["nobody"] }));
    expect(decodeURIComponent(nog.headers.location)).toMatch(/No group maps to a role/);
  });
});

describe("step-up for large approvals", () => {
  it("blocks an approval above the threshold until a fresh TOTP check, and allows small ones", async () => {
    const app = await buildApp(); const sam = await login(app, "usr-controller-sam");
    const big = bigPo(30); // 12600 USD
    const st = (await app.inject({ url: "/auth/step-up", headers: { cookie: sam } })).json();
    expect(st).toMatchObject({ enrolled: false, fresh: false, thresholdUsd: 10000 });
    const r1 = await app.inject({ method: "POST", url: `/approvals/${big.id}`, headers: { cookie: sam }, payload: { approve: true } });
    expect(r1.statusCode).toBe(403); expect(r1.json().error).toMatch(/step_up_required/);
    const secret = await stepUp(app, sam);
    const wrong = await app.inject({ method: "POST", url: "/auth/step-up/verify", headers: { cookie: sam }, payload: { code: SU.totp(secret, Date.now() + 10 * 60_000) } });
    expect(wrong.statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/approvals/${big.id}`, headers: { cookie: sam }, payload: { approve: true } })).json().status).toBe("approved");
    // A different session for the same user is not stepped up.
    const sam2 = await login(app, "usr-controller-sam"); const big2 = bigPo(31);
    expect((await app.inject({ method: "POST", url: `/approvals/${big2.id}`, headers: { cookie: sam2 }, payload: { approve: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/auth/step-up/enroll", headers: { cookie: sam2 } })).statusCode).toBe(409);
  });
  it("gates only above the threshold and matches the RFC 4226 vector", () => {
    const u = P.getUser("usr-controller-sam")!;
    const sid = null;
    expect(() => SU.requireFresh(u, sid, 5000)).not.toThrow();
    expect(() => SU.requireFresh(u, sid, 10001)).toThrow(/step_up_required/);
    expect(SU.hotp(Buffer.from("12345678901234567890"), 1)).toBe("287082"); // RFC 4226 test vector
  });
  it("rejects the same code twice", async () => {
    const app = await buildApp(); const sam = await login(app, "usr-controller-sam");
    const secret = await stepUp(app, sam);
    const again = await app.inject({ method: "POST", url: "/auth/step-up/verify", headers: { cookie: sam }, payload: { code: SU.totp(secret) } });
    expect(again.statusCode).toBe(401);
    const st = SU.status("usr-controller-sam", null, Date.now() + SU.maxAgeMs() + 1);
    expect(st.fresh).toBe(false);
  });
});

describe("KYA uses the AP2 agent key", () => {
  it("signs a fresh challenge with the same Ed25519 key that signs cart mandates", () => {
    const a = db.agents[0];
    expect(a.publicKey).toBe(AP2.publicKeyOf(a.id));
    const sig = KYA.signAs(a.id, "hello");
    expect(KYA.verifySignature(a, "hello", sig)).toBe(true);
    expect(crypto.verify(null, Buffer.from("hello"), AP2.publicKeyOf(a.id)!, Buffer.from(sig, "base64"))).toBe(true);
    const r = KYA.verifyAgent(a, true);
    expect(r.checks[0]).toEqual({ name: "AP2 agent key signs a fresh challenge", pass: true });
    const tampered = { ...a, publicKey: crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() };
    expect(KYA.verifyAgent(tampered, true).verified).toBe(false);
  });
});

describe("rate limits, docs and demo login", () => {
  it("returns 429 per session once the limit is hit, and keeps other sessions working", async () => {
    process.env.RATE_LIMIT_SESSION_MAX = "3";
    const app = await buildApp(); const jane = await login(app, "usr-cfo-jane"); const sam = await login(app, "usr-controller-sam");
    const codes = []; for (let i = 0; i < 4; i++) codes.push((await app.inject({ url: "/me", headers: { cookie: jane } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const last = await app.inject({ url: "/me", headers: { cookie: jane } });
    expect(last.json().error).toMatch(/Too many requests/); expect(last.headers["retry-after"]).toBeTruthy();
    expect((await app.inject({ url: "/me", headers: { cookie: sam } })).statusCode).toBe(200);
  });
  it("returns 429 per API key", async () => {
    process.env.RATE_LIMIT_KEY_MAX = "2";
    const app = await buildApp(); const h = { authorization: "Bearer bpk_not_a_real_key" };
    const codes = []; for (let i = 0; i < 3; i++) codes.push((await app.inject({ url: "/me", headers: h })).statusCode);
    expect(codes).toEqual([401, 401, 429]);
    expect((await app.inject({ url: "/me", headers: { authorization: "Bearer bpk_another" } })).statusCode).toBe(401);
  });
  it("serves OpenAPI at /docs listing the routes", async () => {
    const app = await buildApp(); await app.ready();
    const spec = (await app.inject({ url: "/docs/json" })).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/approvals/{poId}", "/auth/saml/acs", "/auth/step-up/verify", "/me"]));
    expect((await app.inject({ url: "/docs" })).statusCode).toBeLessThan(400);
  });
  it("demo login is off unless DEMO_LOGIN=1", async () => {
    const was = process.env.DEMO_LOGIN; delete process.env.DEMO_LOGIN;
    try {
      const app = await buildApp();
      expect((await app.inject({ url: "/auth/config" })).json().demo).toBe(false);
      expect((await app.inject({ method: "POST", url: "/auth/login", payload: { userId: "usr-cfo-jane" } })).statusCode).toBe(404);
    } finally { if (was !== undefined) process.env.DEMO_LOGIN = was; }
  });
});
