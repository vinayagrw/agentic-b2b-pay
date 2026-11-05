import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { api, useAct, useGet, useMe } from "../lib/api";
import { Badge, Button, Card, EmptyState, ErrorNote, Label, Muted, PageHeader, Select } from "../components/ui";
import { Section } from "../components/Shell";
import { SkeletonTable } from "../components/kit";
import { appPath, readCard, type ChatButton } from "../lib/chat";

type Settings = { enabled: boolean; slack: boolean; teams: boolean; mode: { slack: "mock" | "live"; teams: "mock" | "live" }; updatedBy: string | null };
type Msg = { id: string; provider: "slack" | "teams"; poId: string; delivery: string; state: string; stateText: string | null; createdAt: string; poStatus: string | null; card: any };
type Ident = { provider: "slack" | "teams"; externalId: string; userId: string; name: string; role: string | null };
type Result = { ok: boolean; outcome: string; message: string; deepLink?: string };

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)} className="flex items-center gap-2 text-[13px] disabled:opacity-60">
    <span className={`relative h-5 w-9 rounded-full transition ${on ? "bg-primary" : "bg-border"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${on ? "left-[18px]" : "left-0.5"}`} /></span>{label}</button>;
}

function SettingsCard({ s, admin }: { s: Settings; admin: boolean }) {
  const { run, busy, error } = useAct();
  const save = (x: Partial<Settings>) => run(() => api("/integrations/chat/settings", x));
  return <Card title="Chat approval settings">
    <div className="flex flex-wrap items-center gap-6">
      <Switch on={s.enabled} label="Send approval cards to chat" disabled={!admin || busy} onChange={(v) => save({ enabled: v })} />
      <Switch on={s.slack} label={`Slack (${s.mode.slack === "live" ? "live" : "preview only"})`} disabled={!admin || busy || !s.enabled} onChange={(v) => save({ slack: v })} />
      <Switch on={s.teams} label={`Teams (${s.mode.teams === "live" ? "live" : "preview only"})`} disabled={!admin || busy || !s.enabled} onChange={(v) => save({ teams: v })} />
    </div>
    <p className="mt-3 text-xs text-muted">{admin ? "Only admins can change this." : "Ask an admin to change this."} Orders over the code limit can only be approved in the app.</p>
    <ErrorNote msg={error} />
  </Card>;
}

function ChatCard({ m, actor, onResult }: { m: Msg; actor: Ident | undefined; onResult: (r: Result) => void }) {
  const v = readCard(m.provider, m.card); const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const click = async (b: ChatButton) => {
    if (b.kind === "open") return nav(appPath(b.url));
    if (!actor) return onResult({ ok: false, outcome: "blocked", message: `Pick who is clicking in ${m.provider === "slack" ? "Slack" : "Teams"} first` });
    setBusy(true);
    try { onResult(await api<Result>("/integrations/teams/actions", { token: b.token, chatUserId: actor.externalId })); } catch (e: any) { onResult({ ok: false, outcome: "blocked", message: e.message }); } finally { setBusy(false); }
  };
  const slack = m.provider === "slack";
  const done = m.state !== "pending";
  return <div className={slack ? "rounded-lg border border-border bg-surface p-3 font-[system-ui]" : "rounded-md border border-[#c7c9f0] bg-[#f5f5ff] p-3 text-[#242424] dark:bg-[#2b2b40] dark:text-[#f0f0f0]"}>
    <div className="mb-2 flex items-center gap-2 text-xs">
      <span className={`grid h-6 w-6 place-items-center rounded font-bold text-white ${slack ? "bg-[#4a154b]" : "bg-[#5b5fc7]"}`}>{slack ? "S" : "T"}</span>
      <span className="font-semibold">{slack ? "B2B Pay app" : "B2B Pay Workflows"}</span><Muted>{new Date(m.createdAt).toLocaleTimeString()}</Muted>
      <span className="ml-auto flex gap-1"><Badge v={m.delivery === "mock" ? "preview" : m.delivery} tone="neutral" />{m.poStatus && <Badge v={m.poStatus.replace("_", " ")} />}</span>
    </div>
    <div className={slack ? "border-l-4 border-[#e01e5a] pl-3" : ""}>
      <div className="text-[14px] font-bold">{v.title}</div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">{v.fields.map((f) => <div key={f.label}><dt className="font-semibold">{f.label}</dt><dd className="text-muted">{f.value}</dd></div>)}</dl>
      {v.state && <div className="mt-2 text-[12.5px] font-semibold text-ok">{v.state}</div>}
      <div className="mt-3 flex flex-wrap gap-2">{v.buttons.map((b) => <Button key={b.kind} size="sm" disabled={busy || (done && b.kind !== "open")} variant={b.kind === "approve" ? "primary" : undefined} onClick={() => click(b)}>{b.label}</Button>)}</div>
    </div>
  </div>;
}

export function ChatApprovals() {
  const { data: me } = useMe();
  const { data, isLoading } = useGet<{ messages: Msg[]; settings: Settings }>("/integrations/chat/outbox");
  const { data: ids } = useGet<{ identities: Ident[] }>("/integrations/chat/identities");
  const [actor, setActor] = useState<{ slack: string; teams: string }>({ slack: "", teams: "" });
  const [result, setResult] = useState<(Result & { id: string }) | null>(null);
  const nav = useNavigate(); const qc = useQueryClient();
  useEffect(() => { if (!ids) return; const pick = (p: string) => ids.identities.find((i) => i.provider === p && i.userId !== me?.user.id)?.externalId ?? ""; setActor((a) => ({ slack: a.slack || pick("slack"), teams: a.teams || pick("teams") })); }, [ids, me?.user.id]);
  const who = (p: "slack" | "teams") => ids?.identities.find((i) => i.provider === p && i.externalId === actor[p]);
  const admin = me?.user.role === "client_admin" || me?.user.role === "operator_admin";
  return <Section>
    <PageHeader title="Chat approvals" sub="Approval cards as they look in Slack and Teams. The buttons use the same rules as the app." />
    {data?.settings && <SettingsCard s={data.settings} admin={admin} />}
    <Card title="Who is clicking">
      <div className="flex flex-wrap gap-6">{(["slack", "teams"] as const).map((p) => <div key={p} className="flex flex-col gap-1"><Label>{p === "slack" ? "Slack user" : "Teams user"}</Label>
        <Select value={actor[p]} onChange={(e) => setActor({ ...actor, [p]: e.target.value })}><option value="">Not linked</option>{(ids?.identities ?? []).filter((i) => i.provider === p).map((i) => <option key={i.externalId} value={i.externalId}>{i.name} ({(i.role ?? "").replace("_", " ")})</option>)}</Select></div>)}</div>
      <p className="mt-2 text-xs text-muted">Each chat user is linked to one app user. The person who raised an order cannot approve it.</p>
    </Card>
    {result && <div role="status" className={`rounded-md border px-3 py-2 text-[13px] ${result.ok ? "border-ok/30 bg-ok/10" : "border-warn/40 bg-warn/10"}`}>
      {result.message}{result.deepLink && <button className="ml-2 underline" onClick={() => nav(appPath(result.deepLink))}>Open in app</button>}</div>}
    {isLoading ? <Card pad={false}><SkeletonTable rows={3} cols={3} /></Card> : !data?.messages.length
      ? <EmptyState icon={MessageSquare} title="No chat cards yet" body="When an order needs approval, a card shows up here." />
      : <div className="grid gap-4 lg:grid-cols-2">{data.messages.map((m) => <ChatCard key={m.id} m={m} actor={who(m.provider)} onResult={(r) => { setResult({ ...r, id: m.id }); void qc.invalidateQueries(); }} />)}</div>}
  </Section>;
}
