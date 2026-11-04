import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, useMe } from "./lib/api";
import { Shell } from "./components/Shell";
import * as C from "./pages/client";
import * as O from "./pages/operator";
import { Login, Onboard } from "./pages/public";
import { Loading } from "./pages/flows";

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
    <Route path="/operator" element={<Gate kind="operator" />}>
      <Route index element={<O.OperatorHome />} /><Route path="tenants" element={<O.Tenants />} /><Route path="payments" element={<O.OperatorPayments />} />
      <Route path="compliance" element={<O.Compliance />} /><Route path="treasury" element={<O.Treasury />} /><Route path="reconciliation" element={<O.Recon />} />
      <Route path="revenue" element={<O.Revenue />} /><Route path="developers" element={<O.Developers />} /><Route path="branding" element={<O.BrandingPage />} /><Route path="settings" element={<O.SettingsPage />} />
    </Route>
    <Route path="/app" element={<Gate kind="client" />}>
      <Route index element={<C.ClientHome />} /><Route path="purchase-orders" element={<C.PurchaseOrders />} /><Route path="invoices" element={<C.Invoices />} />
      <Route path="approvals" element={<C.Approvals />} /><Route path="agents" element={<C.Agents />} /><Route path="suppliers" element={<C.Suppliers />} />
      <Route path="payments" element={<C.Payments />} /><Route path="rules" element={<C.Rules />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter></QueryClientProvider>;
}
