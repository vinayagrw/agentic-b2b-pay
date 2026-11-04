import fs from "node:fs";
import path from "node:path";
import { getAddress, createPublicClient, createWalletClient, erc20Abi, http, parseUnits, formatUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { config } from "../config.js";
import { RailError, type RailAdapter, type RailEnv } from "./types.js";

/** Direct USDC on Base with viem. Sandbox is Base Sepolia with a locally generated key in data/keys (gitignored). */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const net = (env: RailEnv) => env === "live"
  ? { chain: base, rpc: config.BASE_MAINNET_RPC, usdc: USDC_BASE, scan: "https://basescan.org" }
  : { chain: baseSepolia, rpc: config.BASE_SEPOLIA_RPC, usdc: USDC_BASE_SEPOLIA, scan: "https://sepolia.basescan.org" };

/** Loads the sandbox key, creating it on first use. Never logged. */
export function sandboxKey(file = config.ONCHAIN_KEY_FILE): Hex {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")).privateKey;
  const privateKey = generatePrivateKey();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ privateKey, address: privateKeyToAccount(privateKey).address, network: "base-sepolia", createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return privateKey;
}
const keyFor = (env: RailEnv): Hex | undefined => (env === "live" ? (config.ONCHAIN_LIVE_PRIVATE_KEY as Hex | undefined) : sandboxKey());
export const onchainAddress = (env: RailEnv = "sandbox") => { const k = keyFor(env); return k ? privateKeyToAccount(k).address : null; };
const pub = (env: RailEnv) => { const n = net(env); return createPublicClient({ chain: n.chain, transport: http(n.rpc) }); };
const txUrl = (env: RailEnv, h: string) => `${net(env).scan}/tx/${h}`;

export const onchainUsdc: RailAdapter = {
  id: "onchain_usdc",
  readiness: (env) => {
    if (env === "live" && !config.ONCHAIN_LIVE_PRIVATE_KEY) return { configured: false, reason: "ONCHAIN_LIVE_PRIVATE_KEY missing" };
    return { configured: true, address: onchainAddress(env) ?? undefined };
  },
  quote: () => ({ rail: "onchain_usdc", label: "USDC on Base (direct)", feeUsd: 0.02, maxAmount: 1_000_000, settleMinutes: 1 }),
  async send(i) {
    if (!i.beneficiary.wallet) throw new RailError(422, "No beneficiary wallet");
    const k = keyFor(i.env); if (!k) throw new RailError(503, "Onchain key not configured");
    const n = net(i.env); const account = privateKeyToAccount(k);
    const value = parseUnits(i.amount.toFixed(2), 6);
    const bal = await pub(i.env).readContract({ address: n.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (bal < value) throw new RailError(402, `Onchain wallet ${account.address} holds ${formatUnits(bal, 6)} USDC, needs ${i.amount.toFixed(2)}. Fund it from the Circle faucet.`);
    const w = createWalletClient({ account, chain: n.chain, transport: http(n.rpc) });
    const hash = await w.writeContract({ address: n.usdc, abi: erc20Abi, functionName: "transfer", args: [getAddress(i.beneficiary.wallet.toLowerCase()), value] });
    return { providerRef: hash, status: "pending", explorerUrl: txUrl(i.env, hash), detail: "Transfer broadcast, waiting for receipt" };
  },
  async status(ref, env) {
    const r = await pub(env).getTransactionReceipt({ hash: ref as Hex }).catch(() => null);
    if (!r) return { providerRef: ref, status: "pending", explorerUrl: txUrl(env, ref), detail: "No receipt yet" };
    return { providerRef: ref, status: r.status === "success" ? "settled" : "failed", explorerUrl: txUrl(env, ref), detail: `Block ${r.blockNumber} ${r.status}` };
  },
  async handleWebhook() { throw new RailError(404, "Onchain rail has no webhooks, the watcher polls receipts"); },
  async balance(env) {
    const a = onchainAddress(env); if (!a) throw new RailError(503, "Onchain key not configured");
    const b = await pub(env).readContract({ address: net(env).usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] });
    return { rail: "onchain_usdc", currency: "USDC", amount: Number(formatUnits(b, 6)), detail: `${a} on ${net(env).chain.name}` };
  },
};
