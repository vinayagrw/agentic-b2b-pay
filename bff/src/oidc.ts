/** OIDC login with openid-client: authorization code flow with PKCE, state and nonce. */
import * as oc from "openid-client";
import * as P from "./platform.js";
import * as I from "./iam.js";

export const publicUrl = () => (process.env.PUBLIC_URL ?? "http://localhost:5180").replace(/\/$/, "");
export const redirectUri = () => process.env.OIDC_REDIRECT_URI ?? `${publicUrl()}/api/auth/oidc/callback`;

async function configFor(idpId: string): Promise<oc.Configuration> {
  const hit = I.discoveryCache.get(idpId) as oc.Configuration | undefined; if (hit) return hit;
  const idp = I.getIdp(idpId); if (!idp || !idp.enabled) throw new P.AuthError(404, "Identity provider not found or turned off");
  const url = new URL(idp.issuer);
  const c = await oc.discovery(url, idp.clientId, idp.secret(), undefined, url.protocol === "http:" ? { execute: [oc.allowInsecureRequests] } : undefined);
  I.discoveryCache.set(idpId, c); return c;
}
export type Pending = { v: string; s: string; n: string; idp: string; at: number };
export async function start(idpId: string): Promise<{ url: string; pending: Pending }> {
  const c = await configFor(idpId);
  const v = oc.randomPKCECodeVerifier(), s = oc.randomState(), n = oc.randomNonce();
  const url = oc.buildAuthorizationUrl(c, { redirect_uri: redirectUri(), scope: "openid email profile", code_challenge: await oc.calculatePKCECodeChallenge(v), code_challenge_method: "S256", state: s, nonce: n });
  return { url: url.href, pending: { v, s, n, idp: idpId, at: Date.now() } };
}
/** Exchanges the code, checks PKCE, state and nonce, then maps claims and provisions the user. */
export async function callback(pending: Pending, query: string) {
  if (Date.now() - pending.at > 10 * 60_000) throw new P.AuthError(400, "Sign in took too long. Start again.");
  const c = await configFor(pending.idp);
  const tokens = await oc.authorizationCodeGrant(c, new URL(`${redirectUri()}${query}`), { pkceCodeVerifier: pending.v, expectedState: pending.s, expectedNonce: pending.n, idTokenExpected: true });
  return completeLogin(pending.idp, tokens.claims() as Record<string, unknown> | undefined, tokens.id_token);
}
/** The part of the callback after the token exchange. Tests call this with a fixed token set. */
export function completeLogin(idpId: string, claims: Record<string, unknown> | undefined, idToken?: string) {
  const idp = I.getIdp(idpId); if (!idp) throw new P.AuthError(404, "Identity provider not found");
  if (!claims) throw new P.AuthError(403, "No ID token claims");
  const user = I.provision(I.mapClaims(claims, idp), idpId);
  return { user, idToken: idToken ?? null };
}
export async function endSessionUrl(idpId: string, idToken: string | null) {
  try {
    const c = await configFor(idpId);
    return oc.buildEndSessionUrl(c, { post_logout_redirect_uri: `${publicUrl()}/login`, ...(idToken ? { id_token_hint: idToken } : {}) }).href;
  } catch { return null; }
}
