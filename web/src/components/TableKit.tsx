import * as React from "react";
import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type RowSelectionState, type SortingState, type VisibilityState } from "@tanstack/react-table";
import { ArrowUpDown, Bookmark, Columns3, Download, Search, Trash2, X } from "lucide-react";
import { api, useAct, useGet } from "../lib/api";
import { cn } from "../lib/utils";
import { Button, EmptyState, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSep, MenuTrigger } from "./ui";

export type ExportKind = "payments" | "approvals" | "suppliers" | "ledger" | "risk";
export type ViewState = { filter?: string; hidden?: string[]; sort?: { id: string; desc: boolean }[]; status?: string };
export type SavedView = { id: string; table: string; name: string; state: ViewState };

/** Downloads a server CSV export. ids limits it to the selected rows. */
export async function downloadCsv(kind: ExportKind, ids?: string[]) {
  const q = ids?.length ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
  const r = await fetch(`/api/export/${kind}${q}`, { credentials: "include" });
  if (!r.ok) throw new Error(`Export failed with HTTP ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a"); a.href = url; a.download = `${kind}${ids?.length ? "-selected" : ""}.csv`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportButton({ kind, ids, label }: { kind: ExportKind; ids?: string[]; label?: string }) {
  const [err, setErr] = React.useState("");
  return <span className="inline-flex items-center gap-1"><Button size="sm" variant="ghost" onClick={() => downloadCsv(kind, ids).then(() => setErr(""), (e) => setErr(e.message))}><Download size={13} aria-hidden />{label ?? "Export CSV"}</Button>{err && <span role="alert" className="text-xs text-bad">{err}</span>}</span>;
}

/** Saved views for one table, stored per user on the server. */
export function ViewsMenu({ table, current, onApply }: { table: ExportKind; current: ViewState; onApply: (s: ViewState) => void }) {
  const { data } = useGet<SavedView[]>(`/views?table=${table}`);
  const { run, error } = useAct();
  const save = () => { const name = window.prompt("Name this view"); if (name?.trim()) run(() => api("/views", { table, name: name.trim(), state: current })); };
  return <Menu><MenuTrigger asChild><Button size="sm" variant="ghost" aria-label="Saved views"><Bookmark size={13} aria-hidden />Views{data?.length ? ` (${data.length})` : ""}</Button></MenuTrigger>
    <MenuContent>
      <MenuLabel>Saved views</MenuLabel>
      {!data?.length && <div className="px-2 py-1 text-xs text-muted">No saved views yet</div>}
      {data?.map((v) => <MenuItem key={v.id} onSelect={() => onApply(v.state)}><span className="flex-1">{v.name}</span>
        <button className="rounded p-1 text-muted hover:text-bad" aria-label={`Delete view ${v.name}`} onClick={(e) => { e.stopPropagation(); e.preventDefault(); run(() => api(`/views/${v.id}`, undefined, { method: "DELETE" })); }}><Trash2 size={12} /></button></MenuItem>)}
      <MenuSep /><MenuItem onSelect={save}>Save current view</MenuItem>
      {error && <div role="alert" className="px-2 py-1 text-xs text-bad">{error}</div>}
    </MenuContent></Menu>;
}

/** Table with search, column picker, saved views, row selection, bulk actions and CSV export. */
export function SmartTable<T>({ table, data, columns, getId, onRow, empty, bulk, extraState, onExtraState }: {
  table: ExportKind; data: T[]; columns: ColumnDef<T, any>[]; getId: (r: T) => string; onRow?: (r: T) => void; empty?: React.ReactNode;
  bulk?: (selected: T[], clear: () => void) => React.ReactNode; extraState?: Omit<ViewState, "filter" | "hidden" | "sort">; onExtraState?: (s: ViewState) => void;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [filter, setFilter] = React.useState("");
  const [visibility, setVisibility] = React.useState<VisibilityState>({});
  const [selection, setSelection] = React.useState<RowSelectionState>({});
  const cols = React.useMemo<ColumnDef<T, any>[]>(() => [{
    id: "_select", enableSorting: false, enableHiding: false,
    header: ({ table: t }) => <input type="checkbox" className="h-4 w-4 accent-[var(--color-primary)]" aria-label="Select all rows" checked={t.getIsAllRowsSelected()} ref={(el) => { if (el) el.indeterminate = t.getIsSomeRowsSelected(); }} onChange={t.getToggleAllRowsSelectedHandler()} />,
    cell: ({ row }) => <input type="checkbox" className="h-4 w-4 accent-[var(--color-primary)]" aria-label={`Select ${row.id}`} checked={row.getIsSelected()} onClick={(e) => e.stopPropagation()} onChange={row.getToggleSelectedHandler()} />,
  }, ...columns], [columns]);
  const t = useReactTable({ data, columns: cols, getRowId: (r) => getId(r), state: { sorting, globalFilter: filter, columnVisibility: visibility, rowSelection: selection }, enableRowSelection: true,
    onSortingChange: setSorting, onGlobalFilterChange: setFilter, onColumnVisibilityChange: setVisibility, onRowSelectionChange: setSelection,
    globalFilterFn: (row, _id, q) => { const s = String(q).toLowerCase(); return !s || JSON.stringify(row.original).toLowerCase().includes(s); },
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel() });
  const selected = t.getSelectedRowModel().rows.map((r) => r.original);
  const clear = () => setSelection({});
  const current: ViewState = { filter, hidden: Object.entries(visibility).filter(([, v]) => v === false).map(([k]) => k), sort: sorting.map((s) => ({ id: s.id, desc: s.desc })), ...extraState };
  const apply = (s: ViewState) => { setFilter(s.filter ?? ""); setVisibility(Object.fromEntries((s.hidden ?? []).map((k) => [k, false]))); setSorting(s.sort ?? []); onExtraState?.(s); };
  const label = (c: any) => typeof c.columnDef.header === "string" ? c.columnDef.header : c.id;
  return <div className="flex flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <label className="relative flex min-w-0 basis-full items-center sm:max-w-xs sm:flex-1 sm:basis-auto"><Search size={13} aria-hidden className="absolute left-2 text-muted" /><span className="sr-only">Filter rows</span>
        <Input className="pl-7" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      <Menu><MenuTrigger asChild><Button size="sm" variant="ghost" aria-label="Choose columns"><Columns3 size={13} aria-hidden />Columns</Button></MenuTrigger>
        <MenuContent><MenuLabel>Show columns</MenuLabel>{t.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => <MenuItem key={c.id} onSelect={(e) => { e.preventDefault(); c.toggleVisibility(); }}>
          <input type="checkbox" readOnly tabIndex={-1} className="h-3.5 w-3.5" checked={c.getIsVisible()} aria-hidden />{label(c)}</MenuItem>)}</MenuContent></Menu>
      <ViewsMenu table={table} current={current} onApply={apply} />
      <ExportButton kind={table} />
    </div>
    {selected.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-3 py-2 text-xs" role="region" aria-label="Bulk actions">
      <span className="font-medium">{selected.length} selected</span>
      {bulk?.(selected, clear)}
      <ExportButton kind={table} ids={selected.map(getId)} label="Export selected" />
      <Button size="sm" variant="ghost" onClick={clear}><X size={13} aria-hidden />Clear</Button>
    </div>}
    {!data.length ? (empty ?? <EmptyState title="Nothing here yet" />) : <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
      <thead>{t.getHeaderGroups().map((g) => <tr key={g.id} className="border-b border-border">{g.headers.map((h) => <th key={h.id} className={cn("px-3 py-2 text-left text-xs font-medium text-muted", h.id === "_select" && "w-8")}>
        {h.column.getCanSort() ? <button className="inline-flex items-center gap-1 hover:text-fg" onClick={h.column.getToggleSortingHandler()}>{flexRender(h.column.columnDef.header, h.getContext())}<ArrowUpDown size={11} aria-hidden /></button> : flexRender(h.column.columnDef.header, h.getContext())}
      </th>)}</tr>)}</thead>
      <tbody>{t.getRowModel().rows.map((r) => <tr key={r.id} className={cn("border-b border-border last:border-0 hover:bg-subtle", r.getIsSelected() && "bg-primary/5", onRow && "cursor-pointer")} tabIndex={onRow ? 0 : undefined} onClick={onRow ? () => onRow(r.original) : undefined} onKeyDown={onRow ? (e) => { if (e.key === "Enter") onRow(r.original); } : undefined}>
        {r.getVisibleCells().map((c) => <td key={c.id} className="px-3 py-2 align-top">{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}</tr>)}</tbody>
    </table>{!t.getRowModel().rows.length && <div className="px-4 py-6 text-center text-xs text-muted">No rows match the filter</div>}</div>}
  </div>;
}
