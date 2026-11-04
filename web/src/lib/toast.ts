/** A tiny app wide toast bus. Any module can push a message, the Toaster shows it. */
export type Toast = { id: number; text: string; tone: "warn" | "bad" | "ok" };
type Fn = (t: Toast) => void;
const subs = new Set<Fn>(); let n = 0;
export function toast(text: string, tone: Toast["tone"] = "warn") { const t = { id: ++n, text, tone }; subs.forEach((f) => f(t)); return t; }
export function onToast(f: Fn) { subs.add(f); return () => { subs.delete(f); }; }
/** The message shown for a 429. Uses the Retry-After seconds when the server sends them. */
export function rateLimitText(retryAfter: string | null) { const s = Number(retryAfter); return Number.isFinite(s) && s > 0 ? `Too many requests. Wait ${Math.ceil(s)} s and try again.` : "Too many requests. Wait a moment and try again."; }
