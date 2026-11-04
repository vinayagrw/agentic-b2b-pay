/**
 * Real OIDC code flow against the local Keycloak, no browser. Fetch with a cookie jar posts the Keycloak login form,
 * then the callback runs inside the bff (in memory DB). Needs infra/keycloak running and OIDC_* in .env.
 * Run: npm run oidc:check -w bff  (optional EMAIL=pat@acme.demo)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.DB_PERSIST = "0"; process.env.LLM_MODE ??= "mock"; process.env.RAIL_POLL_MS = "0";
const { buildApp } = await import("../src/server.js");
const S = await import("../src/service.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const email = process.env.EMAIL ?? "pat@acme.demo";
const row = fs.readFileSync(path.join(root, "infra/keycloak/test-users.local.md"), "utf8").split("\n").find((l) => l.startsWith(`| ${email} |`));
if (!row) throw new Error(`No test user ${email}. Run node infra/keycloak/gen-realm.mjs`);
const [, , tenant, group, password] = row.split("|").map((x) => x.trim());

const jar = new Map<string, string>();
const keep = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const step = (ok: boolean, msg: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) process.exit(1); };

S.bootstrap();
const app = await buildApp();
const start = await app.inject({ url: "/auth/oidc/start" });
step(start.statusCode === 302 && String(start.headers.location).startsWith(process.env.OIDC_ISSUER!), "start redirects to the Keycloak authorize endpoint");
const auth = new URL(String(start.headers.location));
step(auth.searchParams.get("code_challenge_method") === "S256" && !!auth.searchParams.get("state") && !!auth.searchParams.get("nonce"), "authorize request carries PKCE S256, state and nonce");
const oidcCookie = start.cookies.find((c: any) => c.name === "oidc")!;

const page = await fetch(auth, { redirect: "manual" }); keep(page);
const html = await page.text();
const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
step(page.status === 200 && !!action, "Keycloak shows its login form");
const post = await fetch(action!, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams({ username: email, password, credentialId: "" }) });
const back = post.headers.get("location") ?? "";
step(post.status === 302 && back.startsWith("http://localhost:5180/api/auth/oidc/callback?"), "Keycloak accepts the password and redirects to the callback");

const cb = new URL(back);
const done = await app.inject({ url: `/auth/oidc/callback${cb.search}`, headers: { cookie: `oidc=${oidcCookie.value}` } });
const sid = done.cookies.find((c: any) => c.name === "sid");
step(done.statusCode === 302 && !String(done.headers.location).includes("error") && !!sid, `callback exchanges the code and opens a session (${String(done.headers.location)})`);
step(!!sid?.httpOnly && String(sid?.sameSite).toLowerCase() === "lax", "session cookie is httpOnly and sameSite lax");
const me = (await app.inject({ url: "/me", headers: { cookie: `sid=${sid!.value}` } })).json();
step(me.user.email === email && (me.user.tenantId ?? "operator") === tenant && me.user.role === group, `JIT user maps to tenant ${tenant} and role ${group}`);
const replay = await app.inject({ url: `/auth/oidc/callback${cb.search}`, headers: { cookie: `oidc=${oidcCookie.value}` } });
step(String(replay.headers.location).includes("error"), "replaying the same code is rejected");
const out = (await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: `sid=${sid!.value}` }, payload: {} })).json();
step(String(out.redirect ?? "").includes("/protocol/openid-connect/logout") && String(out.redirect).includes("id_token_hint"), "logout returns the Keycloak end session URL");
step((await app.inject({ url: "/me", headers: { cookie: `sid=${sid!.value}` } })).statusCode === 401, "session is gone after logout");
console.log("OIDC live check passed");
await app.close(); process.exit(0);
