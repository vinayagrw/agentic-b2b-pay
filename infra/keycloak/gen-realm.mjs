// Writes the Keycloak realm import with generated passwords and client secret. Nothing here is committed.
// Re-running keeps the passwords, client secret and admin login already generated, so it is safe to run again after adding clients.
import crypto from "node:crypto"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(dir, "../..");
const pw = () => crypto.randomBytes(12).toString("base64url");
const importFile = path.join(dir, "import/b2bpay.local.json");
const prev = fs.existsSync(importFile) ? JSON.parse(fs.readFileSync(importFile, "utf8")) : null;
const prevPw = new Map((prev?.users ?? []).map((u) => [u.email, u.credentials?.[0]?.value]));
const APP = "http://localhost:5180"; const ACS = `${APP}/api/auth/saml/acs`;
const users = [
  ["olivia@operator.demo", "Olivia", "Grant", "operator", "operator_admin"], ["omar@operator.demo", "Omar", "Haddad", "operator", "operator_admin"],
  ["ava@operator.demo", "Ava", "Chen", "operator", "auditor"], ["jane@acme.demo", "Jane", "Okafor", "tnt-acme", "client_admin"],
  ["sam@acme.demo", "Sam", "Rivera", "tnt-acme", "approver"], ["lee@acme.demo", "Lee", "Park", "tnt-acme", "approver"],
  ["pat@acme.demo", "Pat", "Morgan", "tnt-acme", "ap_clerk"], ["gina@globex.demo", "Gina", "Lopez", "tnt-globex", "client_admin"],
  ["gus@globex.demo", "Gus", "Novak", "tnt-globex", "approver"], ["gwen@globex.demo", "Gwen", "Ito", "tnt-globex", "ap_clerk"],
].map(([email, firstName, lastName, tenant, group]) => ({ email, firstName, lastName, tenant, group, password: prevPw.get(email) ?? pw() }));
const secret = prev?.clients?.find((c) => c.clientId === "b2bpay-web")?.secret ?? crypto.randomBytes(24).toString("base64url");
const profile = { unmanagedAttributePolicy: "ENABLED", attributes: [
  { name: "username", displayName: "${username}", permissions: { view: ["admin", "user"], edit: ["admin"] }, validations: { length: { min: 3, max: 255 } } },
  { name: "email", displayName: "${email}", permissions: { view: ["admin", "user"], edit: ["admin"] }, validations: { email: {} } },
  { name: "firstName", displayName: "${firstName}", permissions: { view: ["admin", "user"], edit: ["admin"] } },
  { name: "lastName", displayName: "${lastName}", permissions: { view: ["admin", "user"], edit: ["admin"] } },
] };
const realm = {
  realm: "b2bpay", enabled: true, sslRequired: "none", loginWithEmailAllowed: true,
  groups: ["operator_admin", "client_admin", "approver", "ap_clerk", "auditor"].map((name) => ({ name })),
  components: { "org.keycloak.userprofile.UserProfileProvider": [{ providerId: "declarative-user-profile", config: { "kc.user.profile.config": [JSON.stringify(profile)] } }] },
  clients: [{
    clientId: "b2bpay-web", name: "B2B Pay web", enabled: true, protocol: "openid-connect", publicClient: false, clientAuthenticatorType: "client-secret", secret,
    standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: ["http://localhost:5180/api/auth/oidc/callback"],
    webOrigins: ["http://localhost:5180"], attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "http://localhost:5180/login" },
    protocolMappers: [
      { name: "tenant", protocol: "openid-connect", protocolMapper: "oidc-usermodel-attribute-mapper", config: { "user.attribute": "tenant", "claim.name": "tenant", "jsonType.label": "String", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" } },
      { name: "groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper", config: { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" } },
    ],
  }, {
    // SAML 2.0 SP for the bff. Signs the response and the assertion, sends email as NameID and the same tenant and groups as OIDC.
    clientId: "b2bpay-web-saml", name: "B2B Pay web (SAML)", enabled: true, protocol: "saml", frontchannelLogout: true,
    redirectUris: [ACS], attributes: {
      "saml.server.signature": "true", "saml.assertion.signature": "true", "saml.client.signature": "false", "saml.force.post.binding": "true", "saml.authnstatement": "true",
      "saml.signature.algorithm": "RSA_SHA256", "saml_signature_canonicalization_method": "http://www.w3.org/2001/10/xml-exc-c14n#",
      "saml_force_name_id_format": "true", "saml_name_id_format": "email", "saml_assertion_consumer_url_post": ACS,
    },
    protocolMappers: [
      ...["email", "firstName", "lastName"].map((a) => ({ name: a, protocol: "saml", protocolMapper: "saml-user-property-mapper", config: { "user.attribute": a, "attribute.name": a, "attribute.nameformat": "Basic", "friendly.name": a } })),
      { name: "tenant", protocol: "saml", protocolMapper: "saml-user-attribute-mapper", config: { "user.attribute": "tenant", "attribute.name": "tenant", "attribute.nameformat": "Basic" } },
      { name: "groups", protocol: "saml", protocolMapper: "saml-group-membership-mapper", config: { "attribute.name": "groups", "attribute.nameformat": "Basic", single: "false", "full.path": "false" } },
    ],
  }],
  users: users.map((u) => ({ username: u.email, email: u.email, emailVerified: true, enabled: true, firstName: u.firstName, lastName: u.lastName,
    attributes: { tenant: [u.tenant] }, groups: [`/${u.group}`], credentials: [{ type: "password", value: u.password, temporary: false }] })),
};
fs.mkdirSync(path.join(dir, "import"), { recursive: true });
fs.writeFileSync(importFile, JSON.stringify(realm, null, 2), { mode: 0o600 });
if (!fs.existsSync(path.join(dir, ".env.local"))) fs.writeFileSync(path.join(dir, ".env.local"), `KC_BOOTSTRAP_ADMIN_USERNAME=admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=${pw()}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(dir, "test-users.local.md"), `# Keycloak test users (generated, do not commit)\n\nRealm b2bpay at http://localhost:8180. Admin login is in .env.local.\n\n| Email | Tenant | Group | Password |\n|---|---|---|---|\n${users.map((u) => `| ${u.email} | ${u.tenant} | ${u.group} | ${u.password} |`).join("\n")}\n`, { mode: 0o600 });
// Point the bff at this IdP. Adds or replaces the OIDC lines in the repo .env.
const envFile = path.join(root, ".env"); const old = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
const keep = old.split("\n").filter((l) => !/^OIDC_(ISSUER|CLIENT_ID|CLIENT_SECRET)=/.test(l)).join("\n").replace(/\n*$/, "\n");
const next = `${keep}OIDC_ISSUER=http://localhost:8180/realms/b2bpay\nOIDC_CLIENT_ID=b2bpay-web\nOIDC_CLIENT_SECRET=${secret}\n`;
const want = { OIDC_ISSUER: "http://localhost:8180/realms/b2bpay", OIDC_CLIENT_ID: "b2bpay-web", OIDC_CLIENT_SECRET: secret };
const same = Object.entries(want).every(([k, v]) => new RegExp(`^${k}=(.*)$`, "m").exec(old)?.[1] === v);
if (!same) fs.writeFileSync(envFile, next, { mode: 0o600 }); // leave .env untouched when the values already match
console.log("Wrote import/b2bpay.local.json, .env.local, test-users.local.md and OIDC lines in .env");
