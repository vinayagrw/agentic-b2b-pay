// Writes the Keycloak realm import with generated passwords and client secret. Nothing here is committed.
import crypto from "node:crypto"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url)); const root = path.resolve(dir, "../..");
const pw = () => crypto.randomBytes(12).toString("base64url");
const users = [
  ["olivia@operator.demo", "Olivia", "Grant", "operator", "operator_admin"], ["omar@operator.demo", "Omar", "Haddad", "operator", "operator_admin"],
  ["ava@operator.demo", "Ava", "Chen", "operator", "auditor"], ["jane@acme.demo", "Jane", "Okafor", "tnt-acme", "client_admin"],
  ["sam@acme.demo", "Sam", "Rivera", "tnt-acme", "approver"], ["lee@acme.demo", "Lee", "Park", "tnt-acme", "approver"],
  ["pat@acme.demo", "Pat", "Morgan", "tnt-acme", "ap_clerk"], ["gina@globex.demo", "Gina", "Lopez", "tnt-globex", "client_admin"],
  ["gus@globex.demo", "Gus", "Novak", "tnt-globex", "approver"], ["gwen@globex.demo", "Gwen", "Ito", "tnt-globex", "ap_clerk"],
].map(([email, firstName, lastName, tenant, group]) => ({ email, firstName, lastName, tenant, group, password: pw() }));
const secret = crypto.randomBytes(24).toString("base64url");
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
  }],
  users: users.map((u) => ({ username: u.email, email: u.email, emailVerified: true, enabled: true, firstName: u.firstName, lastName: u.lastName,
    attributes: { tenant: [u.tenant] }, groups: [`/${u.group}`], credentials: [{ type: "password", value: u.password, temporary: false }] })),
};
fs.mkdirSync(path.join(dir, "import"), { recursive: true });
fs.writeFileSync(path.join(dir, "import/b2bpay.local.json"), JSON.stringify(realm, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(dir, ".env.local"), `KC_BOOTSTRAP_ADMIN_USERNAME=admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=${pw()}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(dir, "test-users.local.md"), `# Keycloak test users (generated, do not commit)\n\nRealm b2bpay at http://localhost:8180. Admin login is in .env.local.\n\n| Email | Tenant | Group | Password |\n|---|---|---|---|\n${users.map((u) => `| ${u.email} | ${u.tenant} | ${u.group} | ${u.password} |`).join("\n")}\n`, { mode: 0o600 });
// Point the bff at this IdP. Adds or replaces the OIDC lines in the repo .env.
const envFile = path.join(root, ".env"); const old = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
const keep = old.split("\n").filter((l) => !/^OIDC_(ISSUER|CLIENT_ID|CLIENT_SECRET)=/.test(l)).join("\n").replace(/\n*$/, "\n");
fs.writeFileSync(envFile, `${keep}OIDC_ISSUER=http://localhost:8180/realms/b2bpay\nOIDC_CLIENT_ID=b2bpay-web\nOIDC_CLIENT_SECRET=${secret}\n`, { mode: 0o600 });
console.log("Wrote import/b2bpay.local.json, .env.local, test-users.local.md and OIDC lines in .env");
