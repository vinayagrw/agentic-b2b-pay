import crypto from "node:crypto";
import type { Agent } from "./store.js";

/** Simplified KYA: each agent gets an Ed25519 key, requests are signed, registry binds agent to org and ERP role. */
const privateKeys = new Map<string, crypto.KeyObject>();

export function issueKey(agent: Agent) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  agent.publicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  privateKeys.set(agent.id, privateKey);
  return agent.publicKey;
}

/** Simulates the agent signing on its own side. In production the key never leaves the agent runtime. */
export function signAs(agentId: string, message: string): string {
  const k = privateKeys.get(agentId);
  if (!k) throw new Error(`no key for ${agentId}`);
  return crypto.sign(null, Buffer.from(message), k).toString("base64");
}

export function verifySignature(agent: Agent, message: string, signature: string): boolean {
  if (!agent.publicKey) return false;
  try { return crypto.verify(null, Buffer.from(message), agent.publicKey, Buffer.from(signature, "base64")); } catch { return false; }
}

export type KyaResult = { verified: boolean; checks: { name: string; pass: boolean }[] };
export function verifyAgent(agent: Agent, orgKybVerified: boolean): KyaResult {
  const challenge = `kya-challenge:${agent.id}`;
  let sigOk = false;
  try { sigOk = verifySignature(agent, challenge, signAs(agent.id, challenge)); } catch { sigOk = false; }
  const checks = [
    { name: "Key signature challenge", pass: sigOk },
    { name: "Bound to KYB verified org", pass: orgKybVerified },
    { name: "ERP role assigned", pass: !!agent.erpRole },
  ];
  const verified = checks.every((c) => c.pass);
  agent.kyaStatus = verified ? "verified" : "unverified";
  return { verified, checks };
}
