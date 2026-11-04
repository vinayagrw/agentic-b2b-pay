/** Step-up for large approvals: an RFC 6238 TOTP check bound to the session, valid for a few minutes. */
import crypto from "node:crypto";
import { sql } from "./db.js";
import * as P from "./platform.js";
import * as I from "./iam.js";

export const thresholdUsd = () => Number(process.env.STEP_UP_THRESHOLD_USD ?? 10000);
export const maxAgeMs = () => (Number(process.env.STEP_UP_MAX_AGE_SECONDS) || 300) * 1000;
export const needsStepUp = (amountUsd: number) => amountUsd > thresholdUsd();

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Buffer) { let bits = 0, v = 0, out = ""; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(v << (5 - bits)) & 31]; return out; }
export function unbase32(s: string) { let bits = 0, v = 0; const out: number[] = []; for (const c of s.replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
/** HOTP code for a counter (RFC 4226), SHA-1, 6 digits. */
export function hotp(secret: Buffer, counter: number) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(c).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
export const counterAt = (now = Date.now()) => Math.floor(now / 30_000);
export const totp = (secretB32: string, now = Date.now()) => hotp(unbase32(secretB32), counterAt(now));

const row = (userId: string) => sql.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(userId) as any;
export function status(userId: string, sessionId: string | null, now = Date.now()) {
  const r = row(userId); const s = sessionId ? (sql.prepare("SELECT step_up_at FROM sessions WHERE id = ?").get(sessionId) as any) : null;
  const at = s?.step_up_at ? Date.parse(s.step_up_at) : 0; const fresh = !!at && now - at < maxAgeMs();
  return { enrolled: !!r?.confirmed_at, thresholdUsd: thresholdUsd(), fresh, freshUntil: fresh ? new Date(at + maxAgeMs()).toISOString() : null };
}
/** Starts enrolment. A confirmed factor cannot be replaced here, an admin would reset it. */
export function enroll(u: P.User) {
  const r = row(u.id); if (r?.confirmed_at) throw new P.AuthError(409, "An authenticator is already enrolled");
  const secret = base32(crypto.randomBytes(20));
  sql.prepare("INSERT OR REPLACE INTO user_totp (user_id, secret_enc, confirmed_at, last_counter, created_at) VALUES (?,?,NULL,-1,?)").run(u.id, I.seal(secret), new Date().toISOString());
  P.audit(u.id, "user", u.id, "auth.totp_enrol_started", {});
  return { secret, otpauthUri: `otpauth://totp/B2B%20Pay:${encodeURIComponent(u.email || u.id)}?secret=${secret}&issuer=B2B%20Pay&period=30&digits=6&algorithm=SHA1` };
}
/** Checks a code (one step of drift either way, no reuse), confirms enrolment and marks the session as stepped up. */
export function verify(u: P.User, sessionId: string | null, code: string, now = Date.now()) {
  if (!sessionId) throw new P.AuthError(403, "Step-up needs a signed-in browser session");
  const r = row(u.id); if (!r) throw new P.AuthError(409, "Enrol an authenticator first");
  const secret = unbase32(I.unseal(r.secret_enc)); const c0 = counterAt(now); const want = String(code ?? "").replace(/\D/g, "");
  const hit = want.length !== 6 ? undefined : [c0 - 1, c0, c0 + 1].find((c) => c > r.last_counter && crypto.timingSafeEqual(Buffer.from(hotp(secret, c)), Buffer.from(want)));
  if (hit === undefined) { P.audit(u.id, "user", u.id, "auth.step_up_failed", {}); throw new P.AuthError(401, "That code is not valid. Try the current code."); }
  const at = new Date(now).toISOString();
  sql.prepare("UPDATE user_totp SET last_counter = ?, confirmed_at = COALESCE(confirmed_at, ?) WHERE user_id = ?").run(hit, at, u.id);
  sql.prepare("UPDATE sessions SET step_up_at = ? WHERE id = ?").run(at, sessionId);
  P.audit(u.id, "user", u.id, "auth.step_up", { session: sessionId.slice(0, 12) });
  return status(u.id, sessionId, now);
}
/** Server side gate for approvals above the threshold. */
export function requireFresh(u: P.User, sessionId: string | null, amountUsd: number, now = Date.now()) {
  if (!needsStepUp(amountUsd)) return;
  if (!status(u.id, sessionId, now).fresh) throw new P.AuthError(403, `step_up_required: approvals above ${thresholdUsd()} USD need a fresh authenticator code`);
}
