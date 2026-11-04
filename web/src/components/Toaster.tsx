import { useEffect, useState } from "react";
import { onToast, type Toast } from "../lib/toast";
import { cn } from "../lib/utils";

/** Shows toasts in the bottom right and clears each after a few seconds. */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => onToast((t) => { setItems((xs) => [...xs.filter((x) => x.text !== t.text), t].slice(-3)); setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 5000); }), []);
  return <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
    {items.map((t) => <div key={t.id} role="status" className={cn("pointer-events-auto rounded-md border px-3 py-2 text-[13px] shadow-lg", t.tone === "bad" ? "border-bad/40 bg-surface text-bad" : t.tone === "ok" ? "border-ok/40 bg-surface text-ok" : "border-warn/40 bg-surface text-warn")}>{t.text}</div>)}
  </div>;
}
