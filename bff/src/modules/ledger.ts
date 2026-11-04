import type { Journal, LedgerEntry } from "./store.js";

export type Line = { account: string; debit?: number; credit?: number; origCurrency?: string; origAmount?: number };
let n = 0;
/** Double entry. Rejects any journal where debits do not equal credits. */
export function makeJournal(id: string, memo: string, ref: string, lines: Line[], currency = "USD"): Journal {
  const entries: LedgerEntry[] = lines.map((l) => ({ id: `${id}-L${++n}`, journalId: id, account: l.account, debit: r(l.debit ?? 0), credit: r(l.credit ?? 0), currency, ref, ...(l.origCurrency ? { origCurrency: l.origCurrency, origAmount: r(l.origAmount ?? 0) } : {}) }));
  const d = r(entries.reduce((a, e) => a + e.debit, 0)), c = r(entries.reduce((a, e) => a + e.credit, 0));
  if (d !== c) throw new Error(`Unbalanced journal ${id}: debit ${d} credit ${c}`);
  if (d === 0) throw new Error(`Empty journal ${id}`);
  return { id, memo, ref, createdAt: new Date().toISOString(), entries };
}
export function trialBalance(journals: Journal[]) {
  const acc: Record<string, { debit: number; credit: number; balance: number }> = {};
  for (const j of journals) for (const e of j.entries) {
    const a = (acc[e.account] ??= { debit: 0, credit: 0, balance: 0 });
    a.debit = r(a.debit + e.debit); a.credit = r(a.credit + e.credit); a.balance = r(a.debit - a.credit);
  }
  const totalDebit = r(Object.values(acc).reduce((s, a) => s + a.debit, 0));
  const totalCredit = r(Object.values(acc).reduce((s, a) => s + a.credit, 0));
  return { accounts: acc, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}
/** Reconciliation: every settlement must have a payment journal with the same ref and matching amount. */
export function reconcile(settlements: { id: string; paymentIntentId: string; amount: number }[], journals: Journal[]) {
  return settlements.map((s) => {
    const j = journals.find((x) => x.ref === s.paymentIntentId && x.memo.startsWith("Payment"));
    const ap = j?.entries.filter((e) => e.account === "2000 Accounts payable").reduce((a, e) => a + e.debit, 0) ?? 0;
    return { settlementId: s.id, paymentIntentId: s.paymentIntentId, journalId: j?.id ?? null, matched: !!j && r(ap) === r(s.amount) };
  });
}
const r = (x: number) => Math.round(x * 100) / 100;

/** One entity's books. Every journal is in the entity's functional currency and must balance on its own. */
export function entityBooks(journals: Journal[], entityId: string, functionalCurrency: string, isDefault: boolean) {
  const mine = journals.filter((j) => (j.entityId ?? (isDefault ? entityId : null)) === entityId);
  const wrongCcy = mine.flatMap((j) => j.entries).filter((e) => e.currency !== functionalCurrency).length;
  const tb = trialBalance(mine);
  // Balances per transaction currency: what each account holds in the currency the money was really in.
  const byCurrency: Record<string, Record<string, number>> = {};
  for (const j of mine) for (const e of j.entries) {
    const c = e.origCurrency ?? e.currency; const amt = e.origCurrency ? (e.debit > 0 ? e.origAmount ?? 0 : -(e.origAmount ?? 0)) : e.debit - e.credit;
    const row = (byCurrency[c] ??= {}); row[e.account] = r((row[e.account] ?? 0) + amt);
  }
  return { journals: mine, trialBalance: tb, functionalCurrency, balanced: tb.balanced && wrongCcy === 0, byCurrency };
}
