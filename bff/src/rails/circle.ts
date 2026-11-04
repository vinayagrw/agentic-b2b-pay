import crypto from "node:crypto";
import { config } from "../config.js";
import { sql } from "../db.js";
import { header, RailError, type RailAdapter, type RailEnv, type ProviderStatus } from "./types.js";

/**
 * Circle Web3 Services developer-controlled wallets over REST.
 * Sandbox uses a TEST_API_KEY on https://api.circle.com and BASE-SEPOLIA. The entity secret is encrypted with
 * Circle's entity public key for every mutating call (a fresh ciphertext each time, as Circle requires).
 */
export const USDC = { "BASE-SEPOLIA": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } as const;
const chain = (env: RailEnv) => (env === "live" ? "BASE" : "BASE-SEPOLIA");
const explorer = (env: RailEnv, tx: string) => `https://${env === "live" ? "" : "sepolia."}basescan.org/tx/${tx}`;
const creds = (env: RailEnv) => env === "live"
  ? { key: config.CIRCLE_LIVE_API_KEY, secret: config.CIRCLE_LIVE_ENTITY_SECRET }
  : { key: config.CIRCLE_API_KEY, secret: config.CIRCLE_ENTITY_SECRET };

/** Circle idempotency keys must be UUIDs. Derive a stable one from ours. */
export function uuidFrom(s: string) {
  const h = crypto.createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function mapCircle(state: string): ProviderStatus {
  if (state === "COMPLETE" || state === "CONFIRMED") return "settled";
  if (["FAILED", "CANCELLED", "DENIED"].includes(state)) return "failed";
  return "pending";
}

async function call<T = any>(env: RailEnv, method: string, path: string, body?: unknown): Promise<T> {
  const { key } = creds(env); if (!key) throw new RailError(503, `Circle ${env} API key is not configured`);
  const r = await fetch(`${config.CIRCLE_API_BASE}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new RailError(r.status === 401 ? 503 : 502, `Circle ${method} ${path} failed ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j.data as T;
}
let pubKey: string | null = null;
async function ciphertext(env: RailEnv) {
  const { secret } = creds(env); if (!secret) throw new RailError(503, "Circle entity secret is not configured");
  pubKey ??= (await call<{ publicKey: string }>(env, "GET", "/v1/w3s/config/entity/publicKey")).publicKey;
  return crypto.publicEncrypt({ key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(secret, "hex")).toString("base64");
}

type WalletRef = { walletSetId: string; walletId: string; address: string };
const kvKey = (env: RailEnv) => `circle.wallet.${env}`;
export function storedWallet(env: RailEnv): WalletRef | null {
  const r = sql.prepare("SELECT value FROM kv WHERE key = ?").get(kvKey(env)) as { value: string } | undefined; return r ? JSON.parse(r.value) : null;
}
/** Creates the wallet set and one Base wallet the first time, then reuses them. */
export async function ensureWallet(env: RailEnv): Promise<WalletRef> {
  const have = storedWallet(env); if (have) return have;
  const ws = await call<{ walletSet: { id: string } }>(env, "POST", "/v1/w3s/developer/walletSets", { idempotencyKey: uuidFrom(`walletset-${env}`), entitySecretCiphertext: await ciphertext(env), name: "agentic-b2b-pay treasury" });
  const w = await call<{ wallets: { id: string; address: string }[] }>(env, "POST", "/v1/w3s/developer/wallets", { idempotencyKey: uuidFrom(`wallet-${env}-${ws.walletSet.id}`), entitySecretCiphertext: await ciphertext(env), walletSetId: ws.walletSet.id, blockchains: [chain(env)], count: 1, accountType: "EOA" });
  const ref = { walletSetId: ws.walletSet.id, walletId: w.wallets[0].id, address: w.wallets[0].address };
  sql.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(kvKey(env), JSON.stringify(ref));
  return ref;
}

const pubKeys = new Map<string, string>();
/** Verifies X-Circle-Signature (ECDSA SHA-256, base64) over the raw body with the key named by X-Circle-Key-Id. */
export async function verifyCircleSignature(raw: Buffer, headers: Record<string, string | string[] | undefined>, fetchKey = (id: string) => call<{ publicKey: string }>("sandbox", "GET", `/v2/notifications/publicKey/${id}`).then((d) => d.publicKey)) {
  const sig = header(headers, "x-circle-signature"); const kid = header(headers, "x-circle-key-id");
  if (!sig || !kid) throw new RailError(400, "Missing Circle signature headers");
  let pem = pubKeys.get(kid); if (!pem) { pem = await fetchKey(kid); pubKeys.set(kid, pem); }
  const key = crypto.createPublicKey({ key: Buffer.from(pem, "base64"), format: "der", type: "spki" });
  if (!crypto.verify("sha256", raw, key, Buffer.from(sig, "base64"))) throw new RailError(400, "Circle signature check failed");
}

export const circleUsdc: RailAdapter = {
  id: "circle_usdc",
  readiness: (env) => {
    const c = creds(env);
    if (!c.key) return { configured: false, reason: env === "live" ? "CIRCLE_LIVE_API_KEY missing" : "CIRCLE_API_KEY missing" };
    if (!c.secret) return { configured: false, reason: "Circle entity secret missing" };
    if (env === "sandbox" && !c.key.startsWith("TEST_API_KEY")) return { configured: false, reason: "CIRCLE_API_KEY is not a sandbox key" };
    return { configured: true, address: storedWallet(env)?.address };
  },
  quote: () => ({ rail: "circle_usdc", label: "USDC (Circle)", feeUsd: 0.1, maxAmount: 5_000_000, settleMinutes: 1 }),
  async send(i) {
    if (!i.beneficiary.wallet) throw new RailError(422, "No beneficiary wallet");
    const w = await ensureWallet(i.env);
    const tx = await call<{ id: string; state: string }>(i.env, "POST", "/v1/w3s/developer/transactions/transfer", {
      idempotencyKey: uuidFrom(i.idempotencyKey), entitySecretCiphertext: await ciphertext(i.env), walletId: w.walletId,
      blockchain: chain(i.env), tokenAddress: USDC[chain(i.env)], destinationAddress: i.beneficiary.wallet, amounts: [i.amount.toFixed(2)], feeLevel: "MEDIUM",
      refId: i.intentId,
    });
    return { providerRef: tx.id, status: mapCircle(tx.state), detail: `Circle state ${tx.state}` };
  },
  async status(ref, env) {
    const { transaction: t } = await call<{ transaction: { id: string; state: string; txHash?: string; errorReason?: string } }>(env, "GET", `/v1/w3s/transactions/${ref}`);
    return { providerRef: t.id, status: mapCircle(t.state), explorerUrl: t.txHash ? explorer(env, t.txHash) : undefined, detail: `Circle state ${t.state}${t.errorReason ? " " + t.errorReason : ""}` };
  },
  async handleWebhook(raw, headers) {
    await verifyCircleSignature(raw, headers);
    const n = JSON.parse(raw.toString("utf8"));
    const t = n.notification ?? {};
    if (!String(n.notificationType ?? "").startsWith("transactions.")) return [{ eventId: n.notificationId, type: n.notificationType, providerRef: null }];
    return [{ eventId: n.notificationId, type: n.notificationType, providerRef: t.id, status: mapCircle(t.state), detail: `Circle state ${t.state}`, explorerUrl: t.txHash ? explorer("sandbox", t.txHash) : undefined }];
  },
  async balance(env) {
    const w = await ensureWallet(env);
    const b = await call<{ tokenBalances: { amount: string; token: { symbol: string; tokenAddress?: string } }[] }>(env, "GET", `/v1/w3s/wallets/${w.walletId}/balances`);
    const usdc = b.tokenBalances.find((x) => x.token.symbol === "USDC");
    return { rail: "circle_usdc", currency: "USDC", amount: Number(usdc?.amount ?? 0), detail: `Circle wallet ${w.address} on ${chain(env)}` };
  },
};
