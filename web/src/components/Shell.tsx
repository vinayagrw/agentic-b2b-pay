import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeftRight, Banknote, Bot, Building2, Check, ChevronsUpDown, Code2, FileText, Gauge, Home, Inbox, KeyRound, Landmark, MessageSquare, MonitorSmartphone, UserCog, LogOut, Moon, Palette, Scale, Search, Settings, ShieldAlert, ShieldCheck, ShoppingCart, Sun, Truck, Users, Workflow, type LucideIcon } from "lucide-react";
import { api, useLiveEvents, useMe, type Me } from "../lib/api";
import { applyTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { CommandPalette, ShortcutsOverlay, useShortcuts } from "./CommandPalette";
import { EntitySwitcher } from "../pages/entities";
import { CopilotPanel } from "./Copilot";
import { Badge, Menu, MenuContent, MenuItem, MenuLabel, MenuSep, MenuTrigger } from "./ui";

type Item = { to: string; label: string; icon: LucideIcon };
export const OPERATOR_NAV: Item[] = [
  { to: "/operator", label: "Home", icon: Home }, { to: "/operator/tenants", label: "Tenants", icon: Building2 },
  { to: "/operator/transactions", label: "Transactions", icon: Activity }, { to: "/operator/payments", label: "Payments", icon: ArrowLeftRight }, { to: "/operator/risk", label: "Risk inbox", icon: ShieldAlert }, { to: "/operator/compliance", label: "Compliance", icon: ShieldCheck },
  { to: "/operator/treasury", label: "Treasury", icon: Landmark }, { to: "/operator/reconciliation", label: "Reconciliation", icon: Scale },
  { to: "/operator/revenue", label: "Revenue", icon: Gauge }, { to: "/operator/developers", label: "Developers", icon: Code2 },
  { to: "/operator/branding", label: "Branding", icon: Palette }, { to: "/operator/settings", label: "Settings", icon: Settings },
  { to: "/operator/identity", label: "Identity", icon: KeyRound }, { to: "/operator/roles", label: "Roles", icon: UserCog }, { to: "/operator/sessions", label: "Sessions", icon: MonitorSmartphone },
];
export const CLIENT_NAV: Item[] = [
  { to: "/app", label: "Home", icon: Home }, { to: "/app/purchase-orders", label: "Purchase orders", icon: ShoppingCart },
  { to: "/app/invoices", label: "Invoices", icon: FileText }, { to: "/app/approvals", label: "Approvals", icon: Inbox }, { to: "/app/chat-approvals", label: "Chat approvals", icon: MessageSquare }, { to: "/app/risk", label: "Risk inbox", icon: ShieldAlert },
  { to: "/app/agents", label: "Agents", icon: Bot }, { to: "/app/suppliers", label: "Suppliers", icon: Truck },
  { to: "/app/payments", label: "Payments", icon: Banknote }, { to: "/app/transactions", label: "Transactions", icon: Activity }, { to: "/app/ledger", label: "Entity ledger", icon: Scale }, { to: "/app/rules", label: "Rules", icon: Workflow }, { to: "/app/developers", label: "Developers", icon: Code2 },
  { to: "/app/roles", label: "Roles", icon: UserCog }, { to: "/app/sessions", label: "Sessions", icon: MonitorSmartphone },
];

export function Logo({ name, logo, size = 28 }: { name: string; logo: string | null; size?: number }) {
  if (logo) return <img src={logo} alt="" style={{ width: size, height: size }} className="rounded-md object-contain" />;
  return <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-md bg-primary text-[12px] font-bold text-primary-fg">{name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>;
}

function useColorMode() {
  const [mode, setMode] = useState<string>(() => { try { return localStorage.getItem("color-mode") ?? "auto"; } catch { return "auto"; } });
  useEffect(() => { const el = document.documentElement; if (mode === "auto") delete el.dataset.theme; else el.dataset.theme = mode; try { localStorage.setItem("color-mode", mode); } catch { /* private mode */ } }, [mode]);
  return [mode, setMode] as const;
}

export function Shell({ kind }: { kind: "operator" | "client" }) {
  const { data: me } = useMe();
  const live = useLiveEvents();
  const keys = useShortcuts();
  const [copilot, setCopilot] = useState<{ open: boolean; seed?: string }>({ open: false });
  useEffect(() => { applyTheme(me?.theme); }, [me?.theme]);
  if (!me) return null;
  const nav = kind === "operator" ? OPERATOR_NAV : CLIENT_NAV;
  return <div className="flex min-h-screen">
    <aside className={cn("sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border md:flex", kind === "operator" ? "bg-surface" : "bg-subtle")}>
      <div className="flex items-center gap-2 px-4 py-4"><Logo name={me.theme.name} logo={me.theme.logo} /><div className="min-w-0"><div className="truncate text-[13px] font-semibold">{me.theme.name}</div><div className="truncate text-[11px] text-muted">{kind === "operator" ? "Operator console" : me.tenant.name}</div></div></div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2">{nav.map((n) => <NavLink key={n.to} to={n.to} end={n.to === "/operator" || n.to === "/app"} className={({ isActive }) => cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-bg hover:text-fg", isActive && "bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary")}><n.icon size={15} />{n.label}</NavLink>)}</nav>
      <div className="flex items-center gap-1.5 px-4 py-3 text-[11px] text-muted"><Activity size={12} className={live ? "text-ok" : "text-bad"} />{live ? "Live updates on" : "Reconnecting"}</div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar me={me} kind={kind} onSearch={() => keys.setPalette(true)} onCopilot={() => setCopilot({ open: true })} />
      <nav aria-label="Sections" className="sticky top-12 z-10 flex gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1.5 md:hidden">{nav.map((n) => <NavLink key={n.to} to={n.to} end={n.to === "/operator" || n.to === "/app"} className={({ isActive }) => cn("flex h-10 shrink-0 items-center gap-1.5 rounded-md px-3 text-[13px] text-muted", isActive && "bg-primary/10 font-medium text-primary")}><n.icon size={15} aria-hidden />{n.label}</NavLink>)}</nav>
      <CommandPalette me={me} kind={kind} open={keys.palette} onOpenChange={keys.setPalette} onAsk={(q) => setCopilot({ open: true, seed: q })} />
      <CopilotPanel open={copilot.open} seed={copilot.seed} onClose={() => setCopilot({ open: false })} />
      <ShortcutsOverlay open={keys.help} onOpenChange={keys.setHelp} />
      <main className={cn("mx-auto w-full flex-1 px-4 py-5 md:px-6", kind === "operator" ? "max-w-[1400px]" : "max-w-[1200px]")}><Outlet /></main>
    </div>
  </div>;
}

function TopBar({ me, kind, onSearch, onCopilot }: { me: Me; kind: "operator" | "client"; onSearch: () => void; onCopilot: () => void }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const [mode, setMode] = useColorMode();
  const live = Object.values(me.tenant.railSettings ?? {}).some((r) => r.env === "live");
  const pick = async (id: string, k: string) => { await api("/me/tenant", { tenantId: id }); await qc.invalidateQueries(); nav(k === "client" ? "/app" : "/operator"); };
  const logout = async () => { const r = await api<{ redirect?: string | null }>("/auth/logout", {}); qc.clear(); if (r?.redirect) location.href = r.redirect; else nav("/login"); };
  return <header className="sticky top-0 z-20 flex h-12 items-center gap-3 overflow-x-auto border-b border-border bg-surface/90 px-4 backdrop-blur">
    <Menu><MenuTrigger asChild><button className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-subtle" aria-label="Switch tenant"><Building2 size={14} className="text-muted" /><span className="font-medium">{me.tenant.name}</span><ChevronsUpDown size={13} className="text-muted" /></button></MenuTrigger>
      <MenuContent align="start">
        {(["bank", "client"] as const).map((k) => { const ts = me.tenants.filter((t) => t.kind === k); return ts.length ? <div key={k}><MenuLabel>{k === "bank" ? "Banks" : "Business clients"}</MenuLabel>
          {ts.map((t) => <MenuItem key={t.id} onSelect={() => pick(t.id, k)}><Logo name={t.branding.name} logo={t.branding.logo} size={18} />{t.name}{t.id === me.tenant.id && <Check size={13} className="ml-auto" />}</MenuItem>)}</div> : null; })}
      </MenuContent></Menu>
    <Badge v={live ? "LIVE" : "TEST"} tone={live ? "bad" : "warn"} className="tracking-wide" />
    {me.operator && kind === "client" && <Badge v="Viewing as operator" tone="primary" />}
    {kind === "client" && <EntitySwitcher />}
    <span className="ml-auto" />
    <button className="hidden h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted hover:bg-subtle sm:flex" onClick={onSearch} aria-label="Open command palette"><Search size={13} aria-hidden />Search<kbd className="rounded border border-border bg-subtle px-1 font-mono text-[10px]">Ctrl K</kbd></button>
    <button className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-subtle" onClick={onCopilot} aria-label="Open copilot"><Bot size={13} aria-hidden /><span className="hidden sm:inline">Copilot</span></button>
    <Badge v={`LLM ${me.llmMode}`} tone="neutral" className="hidden sm:inline-flex" />
    <button className="grid h-8 w-8 place-items-center rounded-md hover:bg-subtle" aria-label="Toggle colour mode" onClick={() => setMode(mode === "dark" ? "light" : "dark")}>{mode === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>
    <Menu><MenuTrigger asChild><button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-subtle" aria-label="User menu"><span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg">{me.user.name.split(" ").map((w) => w[0]).join("")}</span><span className="hidden text-left sm:block"><span className="block text-[12px] font-medium leading-tight">{me.user.name}</span><span className="block text-[11px] leading-tight text-muted">{(me.roleName ?? me.user.role).replace("_", " ")}</span></span></button></MenuTrigger>
      <MenuContent>
        <MenuLabel>{me.user.email}</MenuLabel>
        {me.operator && <MenuItem onSelect={() => { const t = me.tenants.find((x) => x.kind === (kind === "operator" ? "client" : "bank")); if (t) pick(t.id, t.kind); }}><Users size={14} />{kind === "operator" ? "Open client workspace" : "Back to operator console"}</MenuItem>}
        <MenuSep /><MenuItem onSelect={logout}><LogOut size={14} />Sign out</MenuItem>
      </MenuContent></Menu>
  </header>;
}

export const Section = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-4">{children}</div>;
