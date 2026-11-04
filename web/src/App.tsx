import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, useMe } from "./lib/api";
import { Shell } from "./components/Shell";
import { Toaster } from "./components/Toaster";
import { lazy, Suspense, type ComponentType } from "react";
import { Login, Onboard } from "./pages/public";
import { Loading } from "./pages/flows";
import { Skeleton, SkeletonTable } from "./components/kit";

/** Route level code splitting. Each page module loads on first visit behind a skeleton. */
const lz = <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType<any>) => lazy(() => load().then((m) => ({ default: pick(m) })));
const client = () => import("./pages/client"); const operator = () => import("./pages/operator"); const iam = () => import("./pages/iam"); const tx = () => import("./pages/txflow");
const C = { ClientHome: lz(client, (m) => m.ClientHome), PurchaseOrders: lz(client, (m) => m.PurchaseOrders), Invoices: lz(client, (m) => m.Invoices), Approvals: lz(client, (m) => m.Approvals), Agents: lz(client, (m) => m.Agents), Suppliers: lz(client, (m) => m.Suppliers), Payments: lz(client, (m) => m.Payments), Rules: lz(client, (m) => m.Rules) };
const O = { OperatorHome: lz(operator, (m) => m.OperatorHome), Tenants: lz(operator, (m) => m.Tenants), OperatorPayments: lz(operator, (m) => m.OperatorPayments), Compliance: lz(operator, (m) => m.Compliance), Treasury: lz(operator, (m) => m.Treasury), Recon: lz(operator, (m) => m.Recon), Revenue: lz(operator, (m) => m.Revenue), Developers: lz(operator, (m) => m.Developers), BrandingPage: lz(operator, (m) => m.BrandingPage), SettingsPage: lz(operator, (m) => m.SettingsPage) };
const IAM = { IdentityPage: lz(iam, (m) => m.IdentityPage), RolesPage: lz(iam, (m) => m.RolesPage), SessionsPage: lz(iam, (m) => m.SessionsPage) };
const FlowPage = lz(tx, (m) => m.FlowPage); const TransactionsPage = lz(tx, (m) => m.TransactionsPage);
const EntityLedgerPage = lz(() => import("./pages/entities"), (m) => m.EntityLedgerPage);
const SupplierPortal = lz(() => import("./pages/sparky"), (m) => m.SupplierPortal);
const RiskInbox = lz(() => import("./pages/risk"), (m) => m.RiskInboxPage);
export const PageSkeleton = () => <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading page"><Skeleton className="h-7 w-48" /><div className="rounded-xl border border-border bg-surface"><SkeletonTable rows={6} cols={5} /></div></div>;
const S = (el: React.ReactNode) => <Suspense fallback={<PageSkeleton />}>{el}</Suspense>;

function Gate({ kind }: { kind: "operator" | "client" }) {
  const { data: me, isLoading, error } = useMe();
  if (isLoading) return <Loading />;
  if (error) return <div className="p-6"><Loading error={error as Error} /></div>;
  if (!me) return <Navigate to="/login" replace />;
  if (kind === "operator" && !me.operator) return <Navigate to="/app" replace />;
  return <Shell kind={kind} />;
}
function Root() { const { data: me, isLoading } = useMe(); if (isLoading) return <Loading />; return <Navigate to={!me ? "/login" : me.operator ? "/operator" : "/app"} replace />; }

export function App() {
  return <QueryClientProvider client={queryClient}><BrowserRouter><Routes>
    <Route path="/" element={<Root />} />
    <Route path="/login" element={<Login />} />
    <Route path="/onboard/:token" element={<Onboard />} />
    <Route path="/supplier/:token" element={<Suspense fallback={<PageSkeleton />}><SupplierPortal /></Suspense>} />
    <Route path="/operator" element={<Gate kind="operator" />}>
      <Route index element={S(<O.OperatorHome />)} /><Route path="tenants" element={S(<O.Tenants />)} /><Route path="payments" element={S(<O.OperatorPayments />)} /><Route path="payments/:id" element={S(<FlowPage />)} /><Route path="transactions" element={S(<TransactionsPage operator />)} />
      <Route path="risk" element={S(<RiskInbox />)} /><Route path="compliance" element={S(<O.Compliance />)} /><Route path="treasury" element={S(<O.Treasury />)} /><Route path="reconciliation" element={S(<O.Recon />)} />
      <Route path="revenue" element={S(<O.Revenue />)} /><Route path="developers" element={S(<O.Developers />)} /><Route path="branding" element={S(<O.BrandingPage />)} /><Route path="settings" element={S(<O.SettingsPage />)} /><Route path="identity" element={S(<IAM.IdentityPage />)} /><Route path="roles" element={S(<IAM.RolesPage />)} /><Route path="sessions" element={S(<IAM.SessionsPage />)} />
    </Route>
    <Route path="/app" element={<Gate kind="client" />}>
      <Route index element={S(<C.ClientHome />)} /><Route path="purchase-orders" element={S(<C.PurchaseOrders />)} /><Route path="invoices" element={S(<C.Invoices />)} />
      <Route path="approvals" element={S(<C.Approvals />)} /><Route path="risk" element={S(<RiskInbox />)} /><Route path="agents" element={S(<C.Agents />)} /><Route path="suppliers" element={S(<C.Suppliers />)} />
      <Route path="payments" element={S(<C.Payments />)} /><Route path="payments/:id" element={S(<FlowPage />)} /><Route path="transactions" element={S(<TransactionsPage operator={false} />)} /><Route path="rules" element={S(<C.Rules />)} /><Route path="ledger" element={S(<EntityLedgerPage />)} /><Route path="developers" element={S(<O.Developers />)} /><Route path="roles" element={S(<IAM.RolesPage />)} /><Route path="sessions" element={S(<IAM.SessionsPage />)} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes><Toaster /></BrowserRouter></QueryClientProvider>;
}
