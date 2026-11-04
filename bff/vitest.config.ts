import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { LLM_MODE: "mock", DB_PERSIST: "0", RAIL_POLL_MS: "0", STRIPE_WEBHOOK_SECRET: "whsec_unit_test_fixture" }, include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"] } });
