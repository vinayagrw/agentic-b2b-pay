import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, persist } from "../config.js";
import { sql } from "../db.js";
import { canonical } from "./evidence.js";

/** AP2 style mandates. Private keys live on disk under data/keys/mandates (gitignored), never in the model context or the API. */
export type SignerKind = "user" | "agent";
export type MandateLine = { sku: string; qty: number; unitPrice: number };
export type IntentBody = { type: "intent"; id: string; poId: string; tenantId: string; principalUserId: string; agentId: string; maxAmount: number; currency: string; supplierId: string; category: string; expiresAt: string; constraints: { allowedRails: string[]; category: string }; createdAt: string };
export type CartBody = { type: "cart"; id: string; poId: string; tenantId: string; agentId: string; intentHash: string; supplierId: string; currency: string; amount: number; lines: MandateLine[]; railHint: string | null; createdAt: string };
export type SignedMandate<B = IntentBody | CartBody> = { id: string; kind: "intent" | "cart"; poId: string; tenantId: string; signerId: string; signerKind: SignerKind; body: B; hash: string; signature: string; createdAt: string; supersededAt: string | null };
export type PaymentBinding = { poId: string; supplierId: string; currency: string; amount: number; lines: MandateLine[] };
export type MandateCheck = { rule: string; pass: boolean; detail: string };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const hashBody = (b: unknown) => sha(canonical(b));
export const normLines = (ls: { sku: string; qty: number; unitPrice: number }[]): MandateLine[] => ls.map((l) => ({ sku: l.sku, qty: Number(l.qty), unitPrice: Math.round(Number(l.unitPrice) * 100) / 100 }));
/** Hash of what the payment will actually pay. Must equal the signed cart hash fields. */
export const bindingHash = (p: PaymentBinding) => hashBody({ poId: p.poId, supplierId: p.supplierId, currency: p.currency, amount: Math.round(p.amount * 100) / 100, lines: normLines(p.lines) });
export const cartBindingHash = (c: CartBody) => bindingHash({ poId: c.poId, supplierId: c.supplierId, currency: c.currency, amount: c.amount, lines: c.lines });

export function keyDir() {
  return process.env.MANDATE_KEY_DIR ?? (persist() ? path.join(path.dirname(config.ONCHAIN_KEY_FILE), "mandates") : path.join(os.tmpdir(), `b2b-ap2-keys-${process.pid}`));
}
const keyFile = (id: string) => path.join(keyDir(), `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.pem`);

/** Returns the public key for a signer, creating a key pair on first use. */
export function ensureKey(signerId: string, kind: SignerKind): string {
  const row = sql.prepare("SELECT public_key FROM signing_keys WHERE signer_id = ?").get(signerId) as { public_key: string } | undefined;
  if (row && fs.existsSync(keyFile(signerId))) return row.public_key;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(keyDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile(signerId), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  sql.prepare("INSERT OR REPLACE INTO signing_keys (signer_id, signer_kind, public_key, created_at) VALUES (?,?,?,?)").run(signerId, kind, pub, new Date().toISOString());
  return pub;
}
export const publicKeyOf = (signerId: string) => (sql.prepare("SELECT public_key FROM signing_keys WHERE signer_id = ?").get(signerId) as { public_key: string } | undefined)?.public_key ?? null;
export const keyFingerprint = (pem: string | null) => (pem ? sha(pem).slice(0, 16) : null);

function sign(signerId: string, kind: SignerKind, body: object) {
  ensureKey(signerId, kind);
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile(signerId)));
  return crypto.sign(null, Buffer.from(canonical(body)), key).toString("base64");
}
export function verifySigned(m: SignedMandate<any>): boolean {
  const pub = publicKeyOf(m.signerId); if (!pub) return false;
  try { return crypto.verify(null, Buffer.from(canonical(m.body)), pub, Buffer.from(m.signature, "base64")); } catch { return false; }
}

function persistMandate<M extends SignedMandate<any>>(m: M): M {
  sql.prepare("INSERT INTO purchase_mandates (id, tenant_id, po_id, kind, signer_id, signer_kind, body, hash, signature, created_at, superseded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(m.id, m.tenantId, m.poId, m.kind, m.signerId, m.signerKind, JSON.stringify(m.body), m.hash, m.signature, m.createdAt, null);
  return m;
}
function make<B extends IntentBody | CartBody>(body: B, signerId: string, signerKind: SignerKind): SignedMandate<B> {
  return { id: body.id, kind: body.type, poId: body.poId, tenantId: body.tenantId, signerId, signerKind, body, hash: hashBody(body), signature: sign(signerId, signerKind, body), createdAt: body.createdAt, supersededAt: null };
}
export function signIntent(body: Omit<IntentBody, "type" | "id" | "createdAt">, save = true) {
  const b: IntentBody = { type: "intent", id: `im-${crypto.randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), ...body };
  const m: SignedMandate<IntentBody> = make(b, b.principalUserId, "user"); return save ? persistMandate(m) : m;
}
export function signCart(body: Omit<CartBody, "type" | "id" | "createdAt">, save = true) {
  const b: CartBody = { type: "cart", id: `cm-${crypto.randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), ...body };
  if (save) sql.prepare("UPDATE purchase_mandates SET superseded_at = ? WHERE po_id = ? AND kind = 'cart' AND superseded_at IS NULL").run(b.createdAt, b.poId);
  const m: SignedMandate<CartBody> = make(b, b.agentId, "agent"); return save ? persistMandate(m) : m;
}
const fromRow = (r: any): SignedMandate => ({ id: r.id, kind: r.kind, poId: r.po_id, tenantId: r.tenant_id, signerId: r.signer_id, signerKind: r.signer_kind, body: JSON.parse(r.body), hash: r.hash, signature: r.signature, createdAt: r.created_at, supersededAt: r.superseded_at });
export const mandatesForPo = (poId: string) => (sql.prepare("SELECT * FROM purchase_mandates WHERE po_id = ? ORDER BY created_at, rowid").all(poId) as any[]).map(fromRow);
export function currentPair(poId: string) {
  const all = mandatesForPo(poId);
  return { intent: all.filter((m) => m.kind === "intent").at(-1) as SignedMandate<IntentBody> | undefined, cart: all.filter((m) => m.kind === "cart" && !m.supersededAt).at(-1) as SignedMandate<CartBody> | undefined };
}

/** Deterministic mandate checks. Runs outside the model. Every check must pass before money moves. */
export function verifyMandatePair(intent: SignedMandate<IntentBody> | undefined, cart: SignedMandate<CartBody> | undefined, payment: PaymentBinding, now = new Date()) {
  const checks: MandateCheck[] = [];
  const add = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });
  if (!intent || !cart) {
    add("Signed mandates present", false, !intent ? "No signed intent mandate for this purchase" : "No signed cart mandate for this purchase");
    return { ok: false, checks, reason: checks[0].detail };
  }
  const i = intent.body, c = cart.body;
  add("Intent signed by the authorising user", intent.signerKind === "user" && intent.signerId === i.principalUserId && verifySigned(intent), `Signer ${intent.signerId}`);
  add("Intent hash intact", hashBody(i) === intent.hash, intent.hash.slice(0, 16));
  add("Cart signed by the buyer agent", cart.signerKind === "agent" && cart.signerId === c.agentId && verifySigned(cart), `Signer ${cart.signerId}`);
  add("Cart hash intact", hashBody(c) === cart.hash, cart.hash.slice(0, 16));
  add("Cart points at this intent", c.intentHash === intent.hash && c.poId === i.poId && c.agentId === i.agentId, c.intentHash.slice(0, 16));
  add("Intent not expired", now <= new Date(i.expiresAt), `Expires ${i.expiresAt}`);
  add("Cart amount within intent limit", c.amount <= i.maxAmount + 1e-9, `${c.amount.toFixed(2)} vs max ${i.maxAmount.toFixed(2)}`);
  add("Cart currency matches intent", c.currency === i.currency, c.currency);
  add("Cart supplier matches intent", c.supplierId === i.supplierId, c.supplierId);
  add("Cart lines add up", Math.abs(c.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) - c.amount) <= 0.01, `${c.lines.length} lines`);
  add("Cart hash matches the payment", cartBindingHash(c) === bindingHash(payment), `Payment ${payment.amount.toFixed(2)} to ${payment.supplierId}`);
  const failed = checks.filter((x) => !x.pass);
  return { ok: failed.length === 0, checks, reason: failed.length ? `Mandate check failed: ${failed.map((f) => `${f.rule} (${f.detail})`).join(", ")}` : "Both mandates valid" };
}
