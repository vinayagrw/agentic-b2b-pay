import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import * as DM from "@radix-ui/react-dropdown-menu";
import { cva, type VariantProps } from "class-variance-authority";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { ArrowUpDown, Inbox, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

const button = cva("inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-primary", {
  variants: {
    variant: {
      primary: "bg-primary text-primary-fg hover:opacity-90",
      outline: "border border-border bg-surface hover:bg-subtle",
      ghost: "hover:bg-subtle",
      danger: "bg-bad text-white hover:opacity-90",
    },
    size: { sm: "h-7 px-2.5", md: "h-8 px-3", icon: "h-8 w-8" },
  },
  defaultVariants: { variant: "outline", size: "md" },
});
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { asChild?: boolean };
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...p }, ref) => {
  const C: any = asChild ? Slot : "button";
  return <C ref={ref} className={cn(button({ variant, size }), className)} {...p} />;
});

export function Card({ title, action, className, children, pad = true }: { title?: React.ReactNode; action?: React.ReactNode; className?: string; children: React.ReactNode; pad?: boolean }) {
  return <section className={cn("rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]", className)}>
    {(title || action) && <header className="flex items-center gap-2 border-b border-border px-4 py-2.5"><h2 className="text-[13px] font-semibold">{title}</h2><div className="ml-auto flex items-center gap-2">{action}</div></header>}
    <div className={pad ? "p-4" : ""}>{children}</div>
  </section>;
}
export function Stat({ label, value, hint, icon: Icon }: { label: string; value: React.ReactNode; hint?: string; icon?: LucideIcon }) {
  return <div className="rounded-xl border border-border bg-surface p-4">
    <div className="flex items-center gap-2 text-muted">{Icon && <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary"><Icon size={16} /></span>}<span className="text-xs font-medium">{label}</span></div>
    <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>{hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
  </div>;
}

const OK = /allow|approved|matched|clear|settled|pass|applied|confirmed|paid|verified|active|true|balanced|sandbox|test/;
const BAD = /deny|denied|blocked|fail|exception|rejected|suspended|false|broken|unbalanced|live|flagged/;
export function Badge({ v, tone, className }: { v: string; tone?: "ok" | "bad" | "warn" | "neutral" | "primary"; className?: string }) {
  const t = tone ?? (BAD.test(v) ? "bad" : OK.test(v) ? "ok" : "warn");
  const cls = { ok: "bg-ok/10 text-ok", bad: "bg-bad/10 text-bad", warn: "bg-warn/10 text-warn", neutral: "bg-subtle text-muted", primary: "bg-primary/10 text-primary" }[t];
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium", cls, className)}>{v}</span>;
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) =>
  <input ref={ref} className={cn("h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-primary", className)} {...p} />);
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) =>
  <textarea ref={ref} className={cn("min-h-20 w-full rounded-md border border-border bg-surface p-2.5 font-mono text-xs outline-none focus:border-primary", className)} {...p} />);
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) =>
  <select ref={ref} className={cn("h-8 rounded-md border border-border bg-surface px-2 text-[13px] outline-none focus:border-primary", className)} {...p} />);
export const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => <label className={cn("text-xs font-medium text-muted", className)}>{children}</label>;

export function Table({ head, children, className }: { head?: React.ReactNode[]; children: React.ReactNode; className?: string }) {
  return <div className={cn("overflow-x-auto", className)}><table className="w-full border-collapse text-[13px]">
    {head && <thead><tr className="border-b border-border">{head.map((h, i) => <th key={i} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}</tr></thead>}
    <tbody className="[&>tr]:border-b [&>tr]:border-border [&>tr:last-child]:border-0 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">{children}</tbody>
  </table></div>;
}
export function DataTable<T>({ data, columns, empty, onRow }: { data: T[]; columns: ColumnDef<T, any>[]; empty?: React.ReactNode; onRow?: (row: T) => void }) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const t = useReactTable({ data, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  if (!data.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
    <thead>{t.getHeaderGroups().map((g) => <tr key={g.id} className="border-b border-border">{g.headers.map((h) => <th key={h.id} className="px-3 py-2 text-left text-xs font-medium text-muted">
      {h.column.getCanSort() ? <button className="inline-flex items-center gap-1 hover:text-fg" onClick={h.column.getToggleSortingHandler()}>{flexRender(h.column.columnDef.header, h.getContext())}<ArrowUpDown size={11} /></button> : flexRender(h.column.columnDef.header, h.getContext())}
    </th>)}</tr>)}</thead>
    <tbody>{t.getRowModel().rows.map((r) => <tr key={r.id} className={cn("border-b border-border last:border-0 hover:bg-subtle", onRow && "cursor-pointer")} tabIndex={onRow ? 0 : undefined} onClick={onRow ? () => onRow(r.original) : undefined} onKeyDown={onRow ? (e) => { if (e.key === "Enter") onRow(r.original); } : undefined}>{r.getVisibleCells().map((c) => <td key={c.id} className="px-3 py-2 align-top">{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}</tr>)}</tbody>
  </table></div>;
}

export function EmptyState({ title, body, icon: Icon = Inbox, action }: { title: string; body?: string; icon?: LucideIcon; action?: React.ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    <span className="grid h-11 w-11 place-items-center rounded-xl bg-subtle text-muted"><Icon size={20} /></span>
    <div className="text-sm font-medium">{title}</div>{body && <p className="max-w-md text-xs text-muted">{body}</p>}{action}
  </div>;
}
export function PageHeader({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-end gap-3"><div><h1 className="text-xl font-semibold tracking-tight">{title}</h1>{sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}</div><div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div></div>;
}
export const Mono = ({ children, className }: { children: React.ReactNode; className?: string }) => <span className={cn("font-mono text-[11.5px]", className)}>{children}</span>;
export const Muted = ({ children, className }: { children: React.ReactNode; className?: string }) => <span className={cn("text-xs text-muted", className)}>{children}</span>;
export const ErrorNote = ({ msg }: { msg?: string }) => msg ? <div role="alert" className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">{msg}</div> : null;
export const Json = ({ v }: { v: unknown }) => <pre>{JSON.stringify(v, null, 2)}</pre>;

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export function MenuContent({ children, align = "end" }: { children: React.ReactNode; align?: "start" | "end" }) {
  return <DM.Portal><DM.Content align={align} sideOffset={6} className="z-50 min-w-56 rounded-lg border border-border bg-surface p-1 text-fg shadow-lg">{children}</DM.Content></DM.Portal>;
}
export const MenuItem = ({ className, ...p }: DM.DropdownMenuItemProps) => <DM.Item className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-subtle", className)} {...p} />;
export const MenuLabel = ({ children }: { children: React.ReactNode }) => <DM.Label className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">{children}</DM.Label>;
export const MenuSep = () => <DM.Separator className="my-1 h-px bg-border" />;
