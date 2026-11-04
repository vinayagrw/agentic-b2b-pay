import crypto from "node:crypto";
import type { Agent } from "./store.js";
import { ensureKey, publicKeyOf, signMessage } from "./ap2.js";

/** KYA: each agent holds its AP2 Ed25519 key (the same key that signs cart mandates), requests are signed with it, registry binds agent to org and ERP role. */
export function issueKey(agent: Agent) {
  agent.publicKey = ensureKey(agent.id, "agent");
  return agent.publicKey;
}

/** Signs with the agent's AP2 Ed25519 private key from the key store. The key never goes to the model or the API. */
export function signAs(agentId: string, message: string): string {
  if (!publicKeyOf(agentId)) throw new Error(`no key for ${agentId}`);
  return signMessage(agentId, "agent", message);
}

export function verifySignature(agent: Agent, message: string, signature: string): boolean {
  if (!agent.publicKey) return false;
  try { return crypto.verify(null, Buffer.from(message), agent.publicKey, Buffer.from(signature, "base64")); } catch { return false; }
}

export type KyaResult = { verified: boolean; checks: { name: string; pass: boolean }[] };
/** Signs a fresh random challenge with the agent's AP2 key and checks it against the registered public key. */
export function verifyAgent(agent: Agent, orgKybVerified: boolean): KyaResult {
  const challenge = `kya-challenge:${agent.id}:${crypto.randomUUID()}`;
  const registered = publicKeyOf(agent.id);
  let sigOk = false;
  try { sigOk = !!registered && agent.publicKey === registered && verifySignature(agent, challenge, signAs(agent.id, challenge)); } catch { sigOk = false; }
  const checks = [
    { name: "AP2 agent key signs a fresh challenge", pass: sigOk },
    { name: "Bound to KYB verified org", pass: orgKybVerified },
    { name: "ERP role assigned", pass: !!agent.erpRole },
  ];
  const verified = checks.every((c) => c.pass);
  agent.kyaStatus = verified ? "verified" : "unverified";
  return { verified, checks };
}
