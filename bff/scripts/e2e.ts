/** Runs the full flow once. With LLM_MODE=live it uses the local claude CLI for draft, invoice reading and explanation. */
process.env.DB_PERSIST = "0";
const store = await import("../src/modules/store.js");
const S = await import("../src/service.js");
const { verifyChain } = await import("../src/modules/evidence.js");
store.reset(); S.bootstrap();
const db = store.db;
console.log(`LLM_MODE=${process.env.LLM_MODE}`);
const t0 = Date.now();
const r = await S.runFlow("We need 2 sealed 6204 ball bearings for the line 3 maintenance window next week");
for (const s of r.steps) console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.step}  ${JSON.stringify(s.detail).slice(0, 220)}`);
const sanc = await S.runFlow("Order 2 tons of 304 stainless sheet", { scenario: "sanctioned" });
const blocked = db.intents.find((i) => i.id === sanc.intentId)?.status === "blocked";
const led = S.ledgerView();
const sources = db.evidence.filter((e) => e.event.startsWith("llm.")).map((e: any) => `${e.event}=${e.payload.source}`);
const pi = db.intents.find((i) => i.id === r.intentId);
// Real rails settle asynchronously. Poll a few times, then report whatever the provider says.
for (let n = 0; n < 6 && pi?.status === "pending"; n++) { await new Promise((x) => setTimeout(x, 5000)); await S.pollSettlements(); }
console.log(`explainedBy=${pi?.explainedBy}  ${sources.join("  ")}`);
const ok = !!pi?.route?.rail && blocked && led.trialBalance.balanced && verifyChain(db.evidence).valid;
console.log(`rail=${pi?.rail} status=${pi?.status} ref=${pi?.providerRef ?? ""} ${pi?.blockedReason ?? ""} sanctionedBlocked=${blocked} ledgerBalanced=${led.trialBalance.balanced} chainValid=${verifyChain(db.evidence).valid} in ${Date.now() - t0} ms`);
console.log(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
export {};
