type Issue = { code?: string; type?: string; minimum?: number; path?: (string | number)[]; message?: string };
const FIELD: Record<string, string> = { lines: "item lines", poId: "order", text: "invoice text", amount: "amount", reason: "reason", iban: "IBAN" };

/** Turns a server "validation" error with field issues into one plain sentence. Other errors pass through. */
export function validationText(j: { error?: string; issues?: Issue[] } | null | undefined): string {
  const e = j?.error ?? "";
  if (e !== "validation" || !j?.issues?.length) return e;
  const parts = j.issues.map((i) => {
    const key = String(i.path?.[0] ?? "");
    if (key === "lines" && i.code === "too_small") return "add at least one item line, for example: SKU-1 | Item name | qty 2 | unit 100.00";
    const name = FIELD[key] ?? (key || "a field");
    return i.code === "too_small" ? `${name} is missing or too short` : `${name} is not valid`;
  });
  return `Check the form: ${parts.join(". ")}.`;
}
