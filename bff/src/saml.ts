/** SAML 2.0 service provider with @node-saml/node-saml. The IdP must sign both the response and the assertion. */
import { SAML, type Profile } from "@node-saml/node-saml";
import * as P from "./platform.js";
import * as I from "./iam.js";
import { publicUrl } from "./oidc.js";

export const SAML_IDP_ID = "saml-platform";
export type SamlSettings = { ssoUrl: string; idpIssuer: string; cert: string; spEntityId: string; acsUrl: string };
let override: Partial<SamlSettings> | null = null;
let cached: { key: string; saml: SAML } | null = null;
/** Tests point the SP at a fixture IdP. Pass null to go back to the environment. */
export function configure(s: Partial<SamlSettings> | null) { override = s; cached = null; }

const issuer = () => (process.env.SAML_IDP_ISSUER ?? process.env.OIDC_ISSUER ?? "").replace(/\/$/, "");
export const spEntityId = () => override?.spEntityId ?? process.env.SAML_SP_ENTITY_ID ?? "b2bpay-web-saml";
export const acsUrl = () => override?.acsUrl ?? `${publicUrl()}/api/auth/saml/acs`;
const ssoUrl = () => override?.ssoUrl ?? process.env.SAML_IDP_SSO_URL ?? (issuer() ? `${issuer()}/protocol/saml` : "");
export const available = () => !!ssoUrl() && process.env.SAML_DISABLED !== "1";

/** The IdP signing certificate: SAML_IDP_CERT, or the first signing key in the IdP metadata. */
async function idpCert(): Promise<string> {
  if (override?.cert) return override.cert;
  if (process.env.SAML_IDP_CERT) return process.env.SAML_IDP_CERT;
  const url = process.env.SAML_IDP_METADATA_URL ?? `${issuer()}/protocol/saml/descriptor`;
  const xml = await (await fetch(url)).text();
  const m = /<(?:ds:|dsig:)?X509Certificate>([^<]+)</.exec(xml);
  if (!m) throw new P.AuthError(502, "Could not read the SAML signing certificate from the IdP metadata");
  return m[1].replace(/\s+/g, "");
}
async function sp(): Promise<SAML> {
  const cert = await idpCert(); const key = `${ssoUrl()}|${cert}|${spEntityId()}`;
  if (cached?.key === key) return cached.saml;
  const saml = new SAML({
    entryPoint: ssoUrl(), issuer: spEntityId(), callbackUrl: acsUrl(), idpCert: cert, idpIssuer: override?.idpIssuer ?? (issuer() || undefined), audience: spEntityId(),
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", wantAssertionsSigned: true, wantAuthnResponseSigned: true,
    validateInResponseTo: "always" as any, requestIdExpirationPeriodMs: 10 * 60_000, acceptedClockSkewMs: 60_000, disableRequestedAuthnContext: true,
  });
  cached = { key, saml }; return saml;
}
export async function authorizeUrl(relayState = ""): Promise<string> { return (await sp()).getAuthorizeUrlAsync(relayState, undefined, {}); }

const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
/** Maps a validated SAML profile to the same claim shape OIDC uses, then to our tenant and role. */
export function profileToClaims(p: Profile): Record<string, unknown> {
  const a = p as Record<string, unknown>; const groups = a.groups ?? a.memberOf;
  return { sub: p.nameID, email: one(a.email ?? a.mail) ?? p.nameID, tenant: one(a.tenant), groups: Array.isArray(groups) ? groups : groups ? [groups] : [], given_name: one(a.firstName), family_name: one(a.lastName) };
}
/** Validates the posted SAMLResponse (signature, issuer, audience, time window, InResponseTo) and provisions the user. */
export async function acs(body: Record<string, string>): Promise<P.User> {
  if (!body?.SAMLResponse) throw new P.AuthError(400, "No SAMLResponse in the post");
  let profile: Profile | null | undefined;
  try { ({ profile } = await (await sp()).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse })); }
  catch (e: any) { throw new P.AuthError(401, `SAML response rejected: ${e?.message ?? "invalid"}`); }
  if (!profile) throw new P.AuthError(401, "SAML response had no assertion");
  const platform = I.getIdp("idp-platform");
  const m = I.mapClaims(profileToClaims(profile), { scope: "platform", groupRoleMap: platform?.groupRoleMap ?? I.DEFAULT_GROUP_MAP });
  return I.provision(m, SAML_IDP_ID);
}
