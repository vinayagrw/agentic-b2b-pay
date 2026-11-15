/** Tariff cash scenario. Duty rates are user inputs on PO lines. There is no live tariff feed. */
import { scoped } from "./modules/store.js";
import { round } from "./modules/match.js";
import { fullDuty, exclusionCovers, TARIFF_DEFAULT_DATE, TARIFF_NOTE } from "@b2b/shared";

export const WEEKS = 12;
export const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A date named in a question: 2027-01-09 or 9 Jan 2027. */
export function dayIn(q: string): string | undefined {
  const iso = q.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]; if (iso) return validDay(iso) ? iso : undefined;
  const m = q.match(/\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{4})\b/i); if (!m) return undefined;
  const d = `${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`; return validDay(d) ? d : undefined;
}

export type DutyLine = { poId: string; sku: string; hsCode: string; originCountry: string; dutyRatePct: number; customsEntryDate: string; exclusionApplies: boolean; dutyWithExclusions: number; dutyWithoutExclusions: number; week: number | null; place: "in_window" | "later" | "past" | "no_date" };
/** Every PO line of the tenant that carries a duty rate, with the duty owed in each case, in USD.
 *  With exclusions: a line marked as excluded pays no duty. Without: the exclusion ends on the chosen date, so an excluded line with customs entry after that date pays full duty. */
export function dutyLines(scope: string | null, after: string, today: string): DutyLine[] {
  const day0 = Date.parse(`${today}T00:00:00Z`); const out: DutyLine[] = [];
  for (const po of scoped(scope).pos) {
    if (po.status === "rejected") continue;
    const toUsd = po.currency !== "USD" && po.usdEquivalent && po.total ? po.usdEquivalent / po.total : 1;
    for (const l of po.lines) {
      if (typeof l.dutyRatePct !== "number") continue;
      const full = round(fullDuty(l) * toUsd); const d = l.customsEntryDate && validDay(l.customsEntryDate) ? Date.parse(`${l.customsEntryDate}T00:00:00Z`) : NaN;
      const n = Number.isNaN(d) ? null : Math.floor((d - day0) / (7 * 864e5));
      out.push({ poId: po.id, sku: l.sku, hsCode: l.hsCode ?? "", originCountry: l.originCountry ?? "", dutyRatePct: l.dutyRatePct, customsEntryDate: l.customsEntryDate ?? "", exclusionApplies: !!l.exclusionApplies,
        dutyWithExclusions: exclusionCovers(l, null) ? 0 : full, dutyWithoutExclusions: exclusionCovers(l, after) ? 0 : full,
        week: n !== null && n >= 0 && n < WEEKS ? n : null, place: n === null ? "no_date" : n < 0 ? "past" : n >= WEEKS ? "later" : "in_window" });
    }
  }
  return out;
}

export type ScenarioRow = { week: string; from: string; otherCashOut: number; dutyWithExclusions: number; dutyWithoutExclusions: number; extraDuty: number; cashOutWithExclusions: number; cashOutWithoutExclusions: number };
/** Weekly cash out for 12 weeks: the cash forecast outflow plus duty in the week of customs entry, in both cases. */
export function scenario(scope: string | null, base: { week: string; from: string; outflow: number }[], after = TARIFF_DEFAULT_DATE, today = new Date().toISOString().slice(0, 10)) {
  const lines = dutyLines(scope, after, today);
  const rows: ScenarioRow[] = base.slice(0, WEEKS).map((b, n) => {
    const xs = lines.filter((l) => l.week === n); const w = round(xs.reduce((a, l) => a + l.dutyWithExclusions, 0)); const wo = round(xs.reduce((a, l) => a + l.dutyWithoutExclusions, 0));
    return { week: b.week, from: b.from, otherCashOut: b.outflow, dutyWithExclusions: w, dutyWithoutExclusions: wo, extraDuty: round(wo - w), cashOutWithExclusions: round(b.outflow + w), cashOutWithoutExclusions: round(b.outflow + wo) };
  });
  const sum = (k: keyof ScenarioRow) => round(rows.reduce((a, r) => a + (r[k] as number), 0));
  const later = lines.filter((l) => l.place === "later");
  return { after, today, rows, lines, note: TARIFF_NOTE,
    totals: { withExclusions: sum("cashOutWithExclusions"), withoutExclusions: sum("cashOutWithoutExclusions"), dutyWithExclusions: sum("dutyWithExclusions"), dutyWithoutExclusions: sum("dutyWithoutExclusions"), extraDuty: sum("extraDuty") },
    outside: { later: later.length, laterExtraDuty: round(later.reduce((a, l) => a + l.dutyWithoutExclusions - l.dutyWithExclusions, 0)), past: lines.filter((l) => l.place === "past").length, noDate: lines.filter((l) => l.place === "no_date").length } };
}
