import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { LogIn } from "lucide-react";
import { api, useGet, type Me } from "../lib/api";
import { afterLogin } from "../lib/session";
import { Badge, Card, ErrorNote, Muted } from "../components/ui";
import { OnboardPortal } from "./workspace";
import { SsoButtons } from "./iam";

const ROLE_LABEL: Record<string, string> = { operator_admin: "Operator admin", client_admin: "Client admin", approver: "Approver", ap_clerk: "AP clerk", auditor: "Auditor" };
export function Login() {
  const { data: cfg } = useGet<{ demo: boolean; sso: { id: string; label: string }[] }>("/auth/config");
  const { data } = useGet<{ users: any[] }>("/auth/demo-users", !!cfg?.demo); const qc = useQueryClient(); const nav = useNavigate();
  const [err, setErr] = useState(() => new URLSearchParams(location.search).get("error") ?? "");
  const go = async (u: any) => { try { await api("/auth/login", { userId: u.id }); await afterLogin(qc, () => api<Me>("/me"), nav); } catch (e: any) { setErr(e.message); } };
  return <div className="grid min-h-screen place-items-center bg-bg p-4">
    <div className="w-full max-w-xl">
      <div className="mb-4 flex items-center gap-2"><LogIn size={18} className="text-primary" /><h1 className="text-lg font-semibold">Sign in</h1></div>
      <Card><ErrorNote msg={err} /><div className="mt-1"><SsoButtons sso={cfg?.sso ?? []} /></div><p className="mt-2 text-xs text-muted">You sign in at your company identity provider. SAML is not available yet.</p></Card>
      {cfg?.demo && <>
        <div className="mb-2 mt-6 flex items-center gap-2"><h2 className="text-[13px] font-semibold">Demo users</h2><Badge v="Demo login, no password" tone="warn" /></div>
        <Card pad={false}><ul className="divide-y divide-border">{(data?.users ?? []).map((u) => <li key={u.id}><button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle" onClick={() => go(u)}>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{u.name.split(" ").map((w: string) => w[0]).join("")}</span>
          <span className="flex-1"><span className="block text-[13px] font-medium">{u.name}</span><Muted>{u.email}</Muted></span>
          <Badge v={ROLE_LABEL[u.role]} tone={u.tenantId ? "neutral" : "primary"} /><Muted className="w-24 text-right">{u.tenantId ?? "operator"}</Muted></button></li>)}</ul></Card>
        <p className="mt-3 text-xs text-muted">Demo login is on because DEMO_LOGIN=1. Turn it off for real use.</p>
      </>}
    </div>
  </div>;
}
export function Onboard() {
  const { token } = useParams();
  return <div className="min-h-screen bg-bg p-4"><div className="mx-auto w-full max-w-2xl py-6"><OnboardPortal token={token ?? ""} /></div></div>;
}
