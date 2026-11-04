import { useMemo, useState } from "react";
import { KeyRound, LogIn, ShieldCheck, ShieldX } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Label, Mono, Muted, PageHeader, Select, Table } from "../components/ui";
import { Section } from "../components/Shell";

type Idp = { id: string; scope: string; issuer: string; clientId: string; groupRoleMap: Record<string, string>; enabled: boolean; updatedAt: string; hasSecret: boolean };
type Role = { id: string; name: string; baseRole: string; permissions: string[]; approveLimit: number | null; entityScope: string[] | null };
type Catalog = { permissions: Record<string, string>; builtin: Record<string, string[]>; clientPermissions: string[] };

/** Operator page: OIDC providers per bank, edited through maker checker. SAML 2.0 SP details shown for the IdP admin. */
export function IdentityPage() {
  const { data } = useGet<{ providers: Idp[]; redirectUri: string; saml?: { available: boolean; entityId: string; acsUrl: string } }>("/identity/configs");
  const { data: changes } = useGet<any[]>("/changes?status=pending");
  const { run, busy, error } = useAct();
  const blank = { id: "", scope: "platform", issuer: "", clientId: "", clientSecret: "", map: JSON.stringify({ operator_admin: "operator_admin", client_admin: "client_admin", approver: "approver", ap_clerk: "ap_clerk", auditor: "auditor" }, null, 1), enabled: true };
  const [f, setF] = useState(blank); const [note, setNote] = useState("");
  const edit = (p: Idp) => setF({ id: p.id, scope: p.scope, issuer: p.issuer, clientId: p.clientId, clientSecret: "", map: JSON.stringify(p.groupRoleMap, null, 1), enabled: p.enabled });
  const submit = () => run(async () => {
    let groupRoleMap: any; try { groupRoleMap = JSON.parse(f.map); } catch { throw new Error("The group to role map must be valid JSON"); }
    const c = await api("/identity/configs", { id: f.id || undefined, scope: f.scope, issuer: f.issuer, clientId: f.clientId, clientSecret: f.clientSecret || undefined, groupRoleMap, enabled: f.enabled });
    setNote(`Change ${c.id} is waiting for a second operator admin to approve it.`); setF(blank);
  });
  const pending = (changes ?? []).filter((c) => c.kind === "identity.oidc");
  return <Section>
    <PageHeader title="Identity" sub="How people sign in. Changes need a second operator admin to approve them." />
    <Card title="OpenID Connect providers">
      {(data?.providers ?? []).length ? <Table head={["Scope", "Issuer", "Client id", "Secret", "Status", ""]}>{data!.providers.map((p) => <tr key={p.id}>
        <td><Mono>{p.scope}</Mono></td><td><Mono>{p.issuer}</Mono></td><td><Mono>{p.clientId}</Mono></td><td><Muted>{p.hasSecret ? "Stored encrypted" : "Missing"}</Muted></td>
        <td><Badge v={p.enabled ? "On" : "Off"} tone={p.enabled ? "ok" : "neutral"} /></td><td><Button size="sm" variant="outline" onClick={() => edit(p)}>Edit</Button></td></tr>)}</Table>
        : <EmptyState title="No provider yet" body="Add one below, or set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET and restart." />}
      <p className="mt-2 text-xs text-muted">Redirect URL to register at the provider: <Mono>{data?.redirectUri}</Mono></p>
    </Card>
    <Card title={f.id ? `Edit ${f.id}` : "Add a provider"}>
      <div className="grid gap-3 md:grid-cols-2">
        <div><Label>Scope (platform or a bank tenant id)</Label><Input value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></div>
        <div><Label>Issuer URL</Label><Input value={f.issuer} placeholder="https://idp.example.com/realms/bank" onChange={(e) => setF({ ...f, issuer: e.target.value })} /></div>
        <div><Label>Client id</Label><Input value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} /></div>
        <div><Label>Client secret {f.id && "(leave empty to keep the stored one)"}</Label><Input type="password" autoComplete="off" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} /></div>
        <div className="md:col-span-2"><Label>Group to role map. Values are built-in roles or custom role ids.</Label><textarea className="h-28 w-full rounded-md border border-border bg-surface p-2 font-mono text-[12px]" value={f.map} onChange={(e) => setF({ ...f, map: e.target.value })} /></div>
        <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Provider is on</label>
      </div>
      <ErrorNote msg={error} />{note && <p className="mt-2 text-xs text-ok">{note}</p>}
      <div className="mt-3 flex gap-2"><Button disabled={busy} onClick={submit}>Request change</Button>{f.id && <Button variant="outline" onClick={() => setF(blank)}>Cancel</Button>}</div>
    </Card>
    {pending.length > 0 && <Card title="Waiting for approval"><Table head={["Change", "Scope", "Requested by", ""]}>{pending.map((c) => <tr key={c.id}><td><Mono>{c.id}</Mono></td><td><Mono>{c.payload.scope}</Mono></td><td><Mono>{c.requestedBy}</Mono></td>
      <td className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => run(() => api(`/changes/${c.id}/decide`, { approve: true }))}>Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/changes/${c.id}/decide`, { approve: false }))}>Reject</Button></td></tr>)}</Table></Card>}
    <Card title="SAML 2.0"><div className="flex flex-col gap-1"><div className="flex items-center gap-2"><Badge v={data?.saml?.available ? "On" : "Not set up"} tone={data?.saml?.available ? "ok" : "neutral"} /><Muted>Signed response and signed assertion required. Attributes email, tenant and groups map like OIDC claims.</Muted></div>{data?.saml && <Muted>Entity ID <code>{data.saml.entityId}</code>, ACS <code>{data.saml.acsUrl}</code>, metadata at /api/auth/saml/metadata</Muted>}</div></Card>
  </Section>;
}

/** Roles editor for the signed-in tenant, plus the permission check panel. */
export function RolesPage() {
  const { data: me } = useMe();
  const { data: cat } = useGet<Catalog>("/iam/permissions");
  const { data: roles } = useGet<Role[]>("/iam/roles");
  const { data: users } = useGet<any[]>("/iam/users");
  const { data: tenants } = useGet<any[]>("/tenants");
  const { run, busy, error } = useAct();
  const client = !me?.operator;
  const pool = useMemo(() => (cat ? (client ? cat.clientPermissions : Object.keys(cat.permissions)) : []), [cat, client]);
  const bases = client ? ["client_admin", "approver", "ap_clerk"] : ["operator_admin", "auditor"];
  const empty = { id: "", name: "", baseRole: bases[bases.length - 1], permissions: [] as string[], approveLimit: "", entityScope: [] as string[] };
  const [f, setF] = useState(empty);
  const clients = (tenants ?? []).filter((t) => t.kind === "client");
  const toggle = (k: "permissions" | "entityScope", v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const save = () => run(async () => { const body = { name: f.name, baseRole: f.baseRole, permissions: f.permissions, approveLimit: f.approveLimit === "" ? null : Number(f.approveLimit), entityScope: f.entityScope }; await (f.id ? api(`/iam/roles/${f.id}`, body, { method: "PUT" }) : api("/iam/roles", body)); setF(empty); });
  return <Section>
    <PageHeader title="Roles" sub={client ? "Custom roles for your company. Built-in roles stay as they are." : "Custom roles for operator staff."} />
    <Card title="Built-in roles">{cat && <Table head={["Role", "Permissions"]}>{Object.entries(cat.builtin).filter(([r]) => (client ? bases.includes(r) : ["operator_admin", "auditor"].includes(r))).map(([r, ps]) => <tr key={r}><td className="whitespace-nowrap font-medium">{r.replace("_", " ")}</td><td><span className="flex flex-wrap gap-1">{ps.map((p) => <Badge key={p} v={p} tone="neutral" />)}</span></td></tr>)}</Table>}</Card>
    <Card title="Custom roles">
      {(roles ?? []).length ? <Table head={["Name", "Based on", "Amount limit", "Entities", "Permissions", ""]}>{roles!.map((r) => <tr key={r.id}><td className="font-medium">{r.name}<div><Mono>{r.id}</Mono></div></td><td>{r.baseRole.replace("_", " ")}</td><td>{r.approveLimit ?? "No limit"}</td><td>{r.entityScope?.join(", ") ?? "All"}</td>
        <td><span className="flex flex-wrap gap-1">{r.permissions.map((p) => <Badge key={p} v={p} tone="neutral" />)}</span></td>
        <td className="flex gap-1"><Button size="sm" variant="outline" onClick={() => setF({ id: r.id, name: r.name, baseRole: r.baseRole, permissions: r.permissions, approveLimit: r.approveLimit === null ? "" : String(r.approveLimit), entityScope: r.entityScope ?? [] })}>Edit</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/iam/roles/${r.id}`, undefined, { method: "DELETE" }))}>Delete</Button></td></tr>)}</Table> : <EmptyState title="No custom roles yet" body="Make one below." />}
    </Card>
    <Card title={f.id ? `Edit ${f.name}` : "New custom role"}>
      <div className="grid gap-3 md:grid-cols-3">
        <div><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><Label>Based on (sets the approval level)</Label><Select value={f.baseRole} onChange={(e) => setF({ ...f, baseRole: e.target.value })}>{bases.map((b) => <option key={b} value={b}>{b.replace("_", " ")}</option>)}</Select></div>
        <div><Label>Approval amount limit (empty means no limit)</Label><Input type="number" min={0} value={f.approveLimit} onChange={(e) => setF({ ...f, approveLimit: e.target.value })} /></div>
      </div>
      <Label className="mt-3 block">Permissions</Label>
      <div className="mt-1 grid gap-1 md:grid-cols-2">{pool.map((p) => <label key={p} className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-1" checked={f.permissions.includes(p)} onChange={() => toggle("permissions", p)} /><span><Mono>{p}</Mono> <Muted>{cat?.permissions[p]}</Muted></span></label>)}</div>
      {!client && <><Label className="mt-3 block">Entity scope (no pick means all business clients)</Label><div className="mt-1 flex flex-wrap gap-3">{clients.map((t) => <label key={t.id} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.entityScope.includes(t.id)} onChange={() => toggle("entityScope", t.id)} />{t.name}</label>)}</div></>}
      <ErrorNote msg={error} />
      <div className="mt-3 flex gap-2"><Button disabled={busy || !f.name} onClick={save}>{f.id ? "Save role" : "Create role"}</Button>{f.id && <Button variant="outline" onClick={() => setF(empty)}>Cancel</Button>}</div>
    </Card>
    <Card title="People and roles">
      <Table head={["Name", "Email", "Role", "Change to"]}>{(users ?? []).map((u) => <tr key={u.id}><td>{u.name}</td><td><Muted>{u.email}</Muted></td><td>{u.customRoleId ? (roles ?? []).find((r) => r.id === u.customRoleId)?.name ?? u.customRoleId : u.role.replace("_", " ")}</td>
        <td><Select disabled={busy || u.id === me?.user.id} value={u.customRoleId ?? u.role} onChange={(e) => run(() => api(`/iam/users/${u.id}/role`, { role: e.target.value }))}>
          {(client ? bases : ["operator_admin", "auditor"]).map((b) => <option key={b} value={b}>{b.replace("_", " ")}</option>)}{(roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></td></tr>)}</Table>
    </Card>
    <PermissionCheck users={users ?? []} perms={cat ? Object.keys(cat.permissions) : []} />
  </Section>;
}

export function PermissionCheck({ users, perms }: { users: any[]; perms: string[] }) {
  const { data: me } = useMe();
  const [q, setQ] = useState({ userId: "", permission: "payments.approve", amount: "", tenantId: "" });
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState("");
  const check = async () => { setErr(""); try { const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v)); setRes(await api(`/iam/check?${p}`)); } catch (e: any) { setErr(e.message); setRes(null); } };
  return <Card title="Permission check">
    <p className="mb-2 text-xs text-muted">Pick a person and an action to see why it is allowed or denied.</p>
    <div className="grid gap-3 md:grid-cols-4">
      <div><Label>Person</Label><Select value={q.userId} onChange={(e) => setQ({ ...q, userId: e.target.value })}><option value="">Me ({me?.user.name})</option>{users.filter((u) => u.id !== me?.user.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></div>
      <div><Label>Permission</Label><Select value={q.permission} onChange={(e) => setQ({ ...q, permission: e.target.value })}>{perms.map((p) => <option key={p}>{p}</option>)}</Select></div>
      <div><Label>Amount (optional)</Label><Input type="number" value={q.amount} onChange={(e) => setQ({ ...q, amount: e.target.value })} /></div>
      <div><Label>Business client (optional)</Label><Input value={q.tenantId} placeholder="tnt-acme" onChange={(e) => setQ({ ...q, tenantId: e.target.value })} /></div>
    </div>
    <div className="mt-3"><Button onClick={check}>Check</Button></div>
    <ErrorNote msg={err} />
    {res && <div className="mt-3 rounded-md border border-border p-3">
      <div className="mb-2 flex items-center gap-2">{res.allowed ? <ShieldCheck size={16} className="text-ok" /> : <ShieldX size={16} className="text-bad" />}<span className="font-medium">{res.allowed ? "Allowed" : "Denied"}</span><Muted>{res.user} as {res.role}</Muted></div>
      <ul className="flex flex-col gap-1 text-[13px]">{res.reasons.map((r: any, i: number) => <li key={i} className={r.ok ? "text-fg" : "text-bad"}>{r.ok ? "Yes. " : "No. "}{r.text}</li>)}</ul>
    </div>}
  </Card>;
}

export function SessionsPage() {
  const { data } = useGet<{ sessions: any[]; canManage: boolean; idleMinutes: number; absoluteHours: number }>("/sessions");
  const { run, busy, error } = useAct();
  return <Section>
    <PageHeader title="Sessions" sub={`Sessions end after ${data?.idleMinutes ?? 30} minutes without activity, and always after ${data?.absoluteHours ?? 12} hours.`} />
    <Card pad={false}><ErrorNote msg={error} />
      {(data?.sessions ?? []).length ? <Table head={["Person", "Method", "Started", "Last active", "Ends by", "From", ""]}>{data!.sessions.map((s) => <tr key={s.id}>
        <td>{s.name}<div><Muted>{s.email}</Muted></div></td><td><Badge v={s.method === "oidc" ? "SSO" : "Demo"} tone={s.method === "oidc" ? "ok" : "warn"} /></td>
        <td><Muted>{new Date(s.createdAt).toLocaleString()}</Muted></td><td><Muted>{new Date(s.lastSeenAt).toLocaleString()}</Muted></td><td><Muted>{new Date(s.expiresAt).toLocaleString()}</Muted></td>
        <td><Muted>{s.ip ?? ""}</Muted></td><td>{s.current ? <Badge v="This session" tone="primary" /> : <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/sessions/${s.id}/revoke`, {}))}>Revoke</Button>}</td></tr>)}</Table>
        : <div className="p-4"><EmptyState title="No open sessions" /></div>}
    </Card>
    {!data?.canManage && <Muted>You see your own sessions. Admins see everyone in the company.</Muted>}
  </Section>;
}

/** SCIM tokens on the Developers page. The token shows once. */
export function ScimTokens() {
  const { data, error: loadErr } = useGet<any[]>("/dev/scim-tokens");
  const { run, busy, error } = useAct(); const [shown, setShown] = useState("");
  return <Card title="SCIM provisioning">
    <p className="mb-2 text-xs text-muted">Your identity provider can create, turn off and remove users at <Mono>{location.origin}/api/scim/v2</Mono> with this bearer token. We store only a hash.</p>
    {loadErr ? <Muted>Pick a business client in the tenant menu to manage its SCIM tokens.</Muted> : <>
      {shown && <div className="mb-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs">Copy this token now. It is shown only once. <Mono className="break-all">{shown}</Mono></div>}
      <ErrorNote msg={error} />
      {(data ?? []).length > 0 && <Table head={["Token", "Created", "Last used", "Status", ""]}>{data!.map((t) => <tr key={t.id}><td><Mono>{t.prefix}...</Mono></td><td><Muted>{t.createdAt.slice(0, 16)}</Muted></td><td><Muted>{t.lastUsedAt?.slice(0, 16) ?? "Never"}</Muted></td>
        <td><Badge v={t.revokedAt ? "Revoked" : "Active"} tone={t.revokedAt ? "neutral" : "ok"} /></td><td>{!t.revokedAt && <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api(`/dev/scim-tokens/${t.id}/revoke`, {}))}>Revoke</Button>}</td></tr>)}</Table>}
      <Button className="mt-2" disabled={busy} onClick={() => run(async () => { const r = await api("/dev/scim-tokens", {}); setShown(r.token); })}><KeyRound size={14} />New SCIM token</Button>
    </>}
  </Card>;
}

export function SsoButtons({ sso }: { sso: { id: string; label: string }[] }) {
  if (!sso.length) return <Muted>No identity provider is set up yet.</Muted>;
  return <div className="flex flex-col gap-2">{sso.map((s) => <a key={s.id} href={`/api/auth/oidc/start?idp=${encodeURIComponent(s.id)}`} className="flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-[14px] font-medium text-primary-fg hover:opacity-90"><LogIn size={16} />{s.label}</a>)}</div>;
}
