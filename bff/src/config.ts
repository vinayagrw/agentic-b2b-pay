import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = path.join(root, ".env");
/** Variables set by the shell win over .env, as dotenv does. */
const shellSet = new Set(Object.keys(process.env));
dotenv.config({ path: ENV_FILE, quiet: true } as any);

const opt = z.string().optional().transform((v) => (v ? v : undefined));
const Schema = z.object({
  BFF_PORT: z.coerce.number().int().default(8790),
  WEB_PORT: z.coerce.number().int().default(5180),
  LLM_MODE: z.string().default("live"),
  SESSION_SECRET: z.string().min(16).default("dev-only-session-secret-change-me"),
  DB_FILE: z.string().default(path.join(root, "data/app.db")),
  DB_PERSIST: z.string().default("1"),
  UPLOAD_DIR: z.string().default(path.join(root, "data/uploads")),
  STRIPE_SECRET_KEY: opt, STRIPE_WEBHOOK_SECRET: opt, STRIPE_LIVE_SECRET_KEY: opt,
  CIRCLE_API_KEY: opt, CIRCLE_ENTITY_SECRET: opt, CIRCLE_LIVE_API_KEY: opt,
  CIRCLE_LIVE_ENTITY_SECRET: opt, CIRCLE_API_BASE: z.string().default("https://api.circle.com"),
  BASE_SEPOLIA_RPC: z.string().default("https://sepolia.base.org"),
  BASE_MAINNET_RPC: z.string().default("https://mainnet.base.org"),
  ONCHAIN_KEY_FILE: z.string().default(path.join(root, "data/keys/base-sepolia.json")),
  ONCHAIN_LIVE_PRIVATE_KEY: opt,
  /** Settlement watcher interval. 0 turns it off. */
  RAIL_POLL_MS: z.coerce.number().int().default(5000),
});
export type Config = z.infer<typeof Schema>;
export const config: Config = Schema.parse(process.env);
export const persist = () => process.env.DB_PERSIST !== "0" && process.env.LLM_MODE !== "mock-test";

/** Rail secrets. Read at call time, never from the import time snapshot, so every readiness check (router, Rails table,
 * balances, sweeps, live mode switch) sees the same value even when .env changed after the process started. */
export type SecretName = "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "STRIPE_LIVE_SECRET_KEY" | "CIRCLE_API_KEY" | "CIRCLE_ENTITY_SECRET" | "CIRCLE_LIVE_API_KEY" | "CIRCLE_LIVE_ENTITY_SECRET" | "ONCHAIN_LIVE_PRIVATE_KEY";
let fileCache: { mtime: number; vals: Record<string, string> } | null = null;
function envFile(): Record<string, string> {
  if (process.env.LLM_MODE === "mock" || process.env.LLM_MODE === "mock-test") return {};
  try { const m = fs.statSync(ENV_FILE).mtimeMs; if (!fileCache || fileCache.mtime !== m) fileCache = { mtime: m, vals: dotenv.parse(fs.readFileSync(ENV_FILE)) }; return fileCache.vals; } catch { return {}; }
}
export function secret(name: SecretName): string | undefined {
  const f = envFile();
  const v = shellSet.has(name) || !(name in f) ? process.env[name] : f[name];
  return v ? v : undefined;
}
