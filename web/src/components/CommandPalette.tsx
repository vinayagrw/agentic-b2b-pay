import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as D from "@radix-ui/react-dialog";
import { useNavigate } from "react-router-dom";
import { Banknote, Bot, Search, Truck } from "lucide-react";
import { useGet, type Me } from "../lib/api";
import { can } from "../lib/perm";
import { usd } from "../lib/utils";
import { CLIENT_NAV, OPERATOR_NAV } from "./Shell";

/** The permission each page needs before the palette offers it. Pages not listed need workspace.read. */
export const PAGE_PERMS: Record<string, string> = {
  "/operator/compliance": "compliance.read", "/operator/treasury": "treasury.read", "/operator/reconciliation": "treasury.read", "/operator/revenue": "treasury.read",
  "/operator/developers": "developers.keys", "/app/developers": "developers.keys", "/operator/branding": "settings.branding", "/operator/identity": "identity.manage",
  "/operator/roles": "roles.manage", "/app/roles": "roles.manage", "/operator": "treasury.read",
};
export function pagesFor(me: Pick<Me, "permissions">, kind: "operator" | "client") {
  return (kind === "operator" ? OPERATOR_NAV : CLIENT_NAV).filter((n) => can(me, PAGE_PERMS[n.to] ?? "workspace.read"));
}

export const SHORTCUTS: [string[], string][] = [
  [["Ctrl", "K"], "Open the command palette (Cmd K on a Mac)"],
  [["?"], "Show this list of shortcuts"],
  [["Ctrl", "K"], "Type a question and pick Ask copilot to open the chat"],
  [["Up", "Down"], "Move through palette results"],
  [["Enter"], "Open the selected result"],
  [["Esc"], "Close a palette, panel or dialog"],
  [["Left", "Right"], "Move between steps on a payment flow"],
];

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Global keyboard handling for the palette and the shortcuts overlay. */
export function useShortcuts() {
  const [palette, setPalette] = useState(false); const [help, setHelp] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setHelp(false); setPalette((v) => !v); return; }
      if (e.key === "?" && !typing(e.target) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setPalette(false); setHelp((v) => !v); }
    };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  }, []);
  return { palette, setPalette, help, setHelp };
}

const item = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] data-[selected=true]:bg-subtle";
const group = "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted";

export function CommandPalette({ me, kind, open, onOpenChange, onAsk }: { me: Me; kind: "operator" | "client"; open: boolean; onOpenChange: (o: boolean) => void; onAsk?: (q: string) => void }) {
  const nav = useNavigate(); const [q, setQ] = useState("");
  const prefix = kind === "operator" ? "/operator" : "/app";
  const read = can(me, "workspace.read");
  const pays = useGet<{ rows: any[] }>(`/transactions?limit=8${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`, open && read);
  const sups = useGet<any[]>("/workspace/suppliers", open && read && kind === "client");
  const pages = pagesFor(me, kind);
  const go = (to: string) => { onOpenChange(false); setQ(""); nav(to); };
  const needle = q.trim().toLowerCase();
  const supRows = (sups.data ?? []).filter((s) => !needle || String(s.name).toLowerCase().includes(needle)).slice(0, 6);
  return <Command.Dialog open={open} onOpenChange={onOpenChange} label="Command palette" shouldFilter={false}
    overlayClassName="fixed inset-0 z-50 bg-black/30" contentClassName="fixed left-1/2 top-[15vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl">
    <div className="flex items-center gap-2 border-b border-border px-3"><Search size={14} aria-hidden className="text-muted" />
      <Command.Input value={q} onValueChange={setQ} placeholder="Jump to a page, payment or supplier" className="h-11 flex-1 bg-transparent text-[13px] outline-none" /></div>
    <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
      <Command.Empty className="px-3 py-6 text-center text-xs text-muted">No matches. Try a payment id or supplier name.</Command.Empty>
      {onAsk && read && <Command.Group heading="Copilot" className={group}>
        <Command.Item value="copilot ask" onSelect={() => { const t = q.trim(); onOpenChange(false); setQ(""); onAsk(t); }} className={item}><Bot size={14} aria-hidden className="text-muted" />{q.trim() ? <>Ask copilot: <span className="truncate">{q.trim()}</span></> : "Open copilot chat"}</Command.Item>
      </Command.Group>}
      {pages.some((p) => !needle || p.label.toLowerCase().includes(needle)) && <Command.Group heading="Pages" className={group}>
        {pages.filter((p) => !needle || p.label.toLowerCase().includes(needle)).map((p) => <Command.Item key={p.to} value={`page ${p.to}`} onSelect={() => go(p.to)} className={item}><p.icon size={14} aria-hidden className="text-muted" />{p.label}</Command.Item>)}
      </Command.Group>}
      {!!pays.data?.rows.length && <Command.Group heading="Payments" className={group}>
        {pays.data.rows.map((r) => <Command.Item key={r.id} value={`pay ${r.id}`} onSelect={() => go(`${prefix}/payments/${r.id}`)} className={item}><Banknote size={14} aria-hidden className="text-muted" /><span className="font-mono text-[12px]">{r.id}</span><span className="truncate text-muted">{r.supplier}</span><span className="ml-auto tabular-nums">{usd(r.amount)}</span></Command.Item>)}
      </Command.Group>}
      {supRows.length > 0 && <Command.Group heading="Suppliers" className={group}>
        {supRows.map((s) => <Command.Item key={s.id} value={`sup ${s.id}`} onSelect={() => go(`${prefix}/suppliers`)} className={item}><Truck size={14} aria-hidden className="text-muted" />{s.name}<span className="ml-auto text-xs text-muted">{s.status}</span></Command.Item>)}
      </Command.Group>}
    </Command.List>
    <div className="flex gap-3 border-t border-border px-3 py-2 text-[11px] text-muted"><span><Kbd>Enter</Kbd> open</span><span><Kbd>Esc</Kbd> close</span><span className="ml-auto"><Kbd>?</Kbd> all shortcuts</span></div>
  </Command.Dialog>;
}

export const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className="rounded border border-border bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg">{children}</kbd>;

export function ShortcutsOverlay({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return <D.Root open={open} onOpenChange={onOpenChange}><D.Portal>
    <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
    <D.Content className="fixed left-1/2 top-[20vh] z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-border bg-surface p-5 text-fg shadow-2xl">
      <D.Title className="text-sm font-semibold">Keyboard shortcuts</D.Title>
      <D.Description className="mt-0.5 text-xs text-muted">Shortcuts work anywhere except while you type in a field.</D.Description>
      <ul className="mt-3 flex flex-col divide-y divide-border">{SHORTCUTS.map(([keys, text]) => <li key={text} className="flex items-center gap-3 py-2 text-[13px]"><span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span><span className="ml-auto text-right text-muted">{text}</span></li>)}</ul>
    </D.Content>
  </D.Portal></D.Root>;
}
