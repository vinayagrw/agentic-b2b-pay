import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(root, ".env"), quiet: true } as any);

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
  BASE_SEPOLIA_RPC: z.string().default("https://sepolia.base.org"),
});
export type Config = z.infer<typeof Schema>;
export const config: Config = Schema.parse(process.env);
export const persist = () => process.env.DB_PERSIST !== "0" && process.env.LLM_MODE !== "mock-test";
