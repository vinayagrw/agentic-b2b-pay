import type { Rail } from "@b2b/shared";
import type { RailAdapter } from "./types.js";
import { stripeAch, stripeCard } from "./stripe.js";
import { circleUsdc } from "./circle.js";
import { onchainUsdc } from "./onchain.js";

export * from "./types.js";
export const RAIL_IDS: Rail[] = ["stripe_card", "stripe_ach", "circle_usdc", "onchain_usdc"];
const real = (): Record<Rail, RailAdapter> => ({ stripe_card: stripeCard, stripe_ach: stripeAch, circle_usdc: circleUsdc, onchain_usdc: onchainUsdc });
let adapters: Record<Rail, RailAdapter> = real();

export const adapter = (r: Rail) => adapters[r];
export const allAdapters = () => RAIL_IDS.map((r) => adapters[r]);
/** Tests swap in an in-process fake. Production code never calls this. */
export function setAdapters(a: Partial<Record<Rail, RailAdapter>> | null) { adapters = a ? { ...real(), ...a } : real(); }

/** The one source of truth for "is this rail configured" in an environment. Router, Rails table, balances, sweeps,
 * live switch and supplier bank setup all call this. Keys are read at call time (see config.secret). */
export const railReadiness = (r: Rail, env: import("./types.js").RailEnv) => adapters[r].readiness(env);
