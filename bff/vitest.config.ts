import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { LLM_MODE: "mock", DB_PERSIST: "0", RAIL_DELAY_MS: "0" }, include: ["test/**/*.test.ts"] } });
