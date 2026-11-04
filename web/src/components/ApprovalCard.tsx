import { useState } from "react";
import { AlertTriangle, Bot, Check, KeyRound, ShieldCheck, ShieldX, User, X } from "lucide-react";
import { RAIL_LABEL, type Rail } from "@b2b/shared";
import { api, useAct, useGet, useMe } from "../lib/api";
import { can, stepUpNeeded, type StepUpStatus } from "../lib/perm";
import { cn, usd } from "../lib/utils";
import { Badge, Button, Card, ErrorNote, Input, Mono, Muted, Textarea } from "./ui";
import { StatusDot } from "./kit";
import { ConfidenceList } from "./ConfidenceBar";
import type { Confidence } from "../lib/live";

export type ApprovalItem = {
  id: string; status: string; total: number; category: string; supplier: string; agent: string; justification: string; createdAt?: string;
  lines: { sku: string; qty: number; description: string; unitPrice: number }[];
  maker?: { kind: "agent" | "person"; name: string }; rail?: string | null;
  policy?: { outcome: "allow" | "needs_approval" | "deny"; checks: { rule: string; pass: boolean; detail: string }[] };
  riskFlags?: string[]; confidence?: Confidence[];
  approval: null | { ruleName: string; current: number; levels: { role: string; count: number; approvals: { userId: string; name: string; comment?: string }[] }[]; rejectedBy?: { name: string; comment?: string } };
  canAct: boolean; why?: string;
};

const OUTCOME: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = { allow: { text: "Policy allows", tone: "ok" }, needs_approval: { text: "Policy needs approval", tone: "warn" }, deny: { text: "Policy denies", tone: "bad" } };
const roleText = (r: string) => r.replaceAll("_", " ");

/** Why the decision buttons are off, or null when the user may decide. Rejecting always needs a reason. */
export function decisionBlock(item: Pick<ApprovalItem, "status" | "canAct" | "why">, hasPermission: boolean): string | null {
  if (item.status !== "pending_approval") return "This order is already decided.";
  if (!hasPermission) return "Your role does not hold the payments.approve permission.";
  if (!item.canAct) return item.why ?? "You are not an approver at the current level.";
  return null;
}


/** Asks for a code from the authenticator app, with first time setup. */
export function StepUpPrompt({ s, threshold }: { s: StepUpStatus; threshold: number }) {
  const { run, busy, error } = useAct(); const [code, setCode] = useState(""); const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const verify = async () => { const r = await run(() => api("/auth/step-up/verify", { code })); if (r !== undefined) setCode(""); };
  return <div className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-3" data-testid="step-up">
    <div className="flex items-center gap-1.5 text-xs font-medium"><KeyRound size={13} aria-hidden className="text-warn" />Confirm it is you</div>
    <p className="mt-1 text-xs text-muted">Approvals above {usd(threshold)} need a fresh code from your authenticator app. It stays valid for a few minutes.</p>
    {!s.enrolled && !setup && <Button size="sm" className="mt-2 h-11 w-full sm:h-7 sm:w-auto" disabled={busy} onClick={async () => { const r = await run(() => api<{ secret: string; otpauthUri: string }>("/auth/step-up/enroll", {})); if (r) setSetup(r); }}>Set up authenticator</Button>}
    {setup && <div className="mt-2 text-xs">Add this key to your authenticator app, then enter the 6 digit code. <Mono className="break-all">{setup.secret}</Mono> <a className="text-primary underline" href={setup.otpauthUri}>Open in app</a></div>}
    {(s.enrolled || setup) && <div className="mt-2 flex gap-2"><Input aria-label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" className="h-11 w-full text-base sm:h-8 sm:w-28 sm:text-[13px]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      <Button size="sm" variant="primary" className="h-11 px-5 sm:h-7 sm:px-2.5" disabled={busy || code.length !== 6} onClick={verify}>Verify</Button></div>}
    <ErrorNote msg={error} />
  </div>;
}

/** Maker checker card. The maker is shown up front, the checker decides with a reason on record. */
export function ApprovalCard({ p, onDecided, selected, onSelect }: { p: ApprovalItem; onDecided?: (approve: boolean) => void; selected?: boolean; onSelect?: (on: boolean) => void }) {
  const { data: me } = useMe(); const { run, busy, error } = useAct();
  const [reason, setReason] = useState(""); const [rejecting, setRejecting] = useState(false);
  const blocked = decisionBlock(p, can(me, "payments.approve"));
  const { data: su } = useGet<StepUpStatus>("/auth/step-up", !blocked && p.status === "pending_approval");
  const needStepUp = stepUpNeeded(p.total, su);
  const decide = async (approve: boolean) => { const r = await run(() => api(`/approvals/${p.id}`, { approve, comment: reason.trim() })); if (r !== undefined) { setReason(""); setRejecting(false); onDecided?.(approve); } };
  const maker = p.maker ?? { kind: "agent" as const, name: p.agent };
  const MakerIcon = maker.kind === "agent" ? Bot : User;
  const outcome = p.policy ? OUTCOME[p.policy.outcome] : null;
  const flags = p.riskFlags ?? [];
  return <Card className={cn(p.status !== "pending_approval" && "opacity-80")}>
    <div className="flex flex-wrap items-start gap-3">
      {onSelect && p.status === "pending_approval" && <label className="-m-2 grid h-11 w-11 shrink-0 cursor-pointer place-items-center"><input type="checkbox" className="h-5 w-5" aria-label={`Select ${p.id}`} checked={!!selected} onChange={(e) => onSelect(e.target.checked)} /></label>}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-muted">{p.supplier}</div>
        <div className="text-2xl font-semibold tabular-nums">{usd(p.total)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 font-medium"><MakerIcon size={11} aria-hidden />Made by {maker.name}</span>
          {p.rail && <Badge v={`Rail ${RAIL_LABEL[p.rail as Rail] ?? p.rail}`} tone="neutral" />}
          <Mono className="text-muted">{p.id}</Mono>
        </div>
      </div>
      <StatusDot tone={p.status === "pending_approval" ? "warn" : p.status === "rejected" ? "bad" : "ok"} label={p.status === "pending_approval" ? "Waiting" : p.status.replaceAll("_", " ")} />
    </div>
    <p className="mt-2 text-[13px]">{p.justification}</p>
    <ul className="mt-1 text-xs text-muted">{p.lines.map((l) => <li key={l.sku}>{l.qty} x {l.description} at {usd(l.unitPrice)}</li>)}</ul>

    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-border p-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">{outcome?.tone === "bad" ? <ShieldX size={13} aria-hidden className="text-bad" /> : <ShieldCheck size={13} aria-hidden className="text-ok" />}Policy result</div>
        {outcome ? <Badge v={outcome.text} tone={outcome.tone} /> : <Muted>No policy record</Muted>}
        {p.policy && <ul className="mt-1.5 flex flex-col gap-0.5">{p.policy.checks.map((c, n) => <li key={n}><StatusDot tone={c.pass ? "ok" : "bad"} label={<span className={c.pass ? "text-muted" : "text-bad"}>{c.rule}</span>} /></li>)}</ul>}
      </div>
      <div className="rounded-lg border border-border p-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium"><AlertTriangle size={13} aria-hidden className={flags.length ? "text-warn" : "text-muted"} />Risk flags</div>
        {flags.length ? <ul className="flex flex-col gap-0.5 text-xs text-warn">{flags.map((f) => <li key={f}>{f}</li>)}</ul> : <Muted>No risk flags</Muted>}
      </div>
    </div>

    {p.confidence && <ConfidenceList className="mt-2" items={p.confidence} />}

    {p.approval && <div className="mt-3 rounded-lg bg-subtle p-3"><div className="text-xs font-medium">Rule: {p.approval.ruleName}</div>
      <ol className="mt-2 flex flex-col gap-1">{p.approval.levels.map((l, n) => { const done = l.approvals.length >= l.count; const cur = n === p.approval!.current && p.status === "pending_approval";
        return <li key={n} className="flex flex-wrap items-center gap-2 text-xs"><span className={cn("grid h-5 w-5 place-items-center rounded-full", done ? "bg-ok text-white" : cur ? "bg-primary text-primary-fg" : "bg-border")}>{done ? <Check size={11} aria-hidden /> : n + 1}</span>
          <span className="font-medium">{l.count} {roleText(l.role)}{l.count > 1 ? "s" : ""}</span>{l.approvals.map((a) => <span key={a.userId} className="text-muted">{a.name}{a.comment ? `: "${a.comment}"` : ""}</span>)}</li>; })}</ol>
      {p.approval.rejectedBy && <div className="mt-2 text-xs text-bad">Rejected by {p.approval.rejectedBy.name}{p.approval.rejectedBy.comment ? `: "${p.approval.rejectedBy.comment}"` : ""}</div>}</div>}

    {p.status === "pending_approval" && (blocked ? <Muted className="mt-3 block">{blocked}</Muted> : <div className="mt-3 flex flex-col gap-2">
      {needStepUp && su && <StepUpPrompt s={su} threshold={su.thresholdUsd} />}
      <label className="text-xs font-medium text-muted" htmlFor={`reason-${p.id}`}>{rejecting ? "Reason for rejecting (required)" : "Reason for the record"}</label>
      <Textarea id={`reason-${p.id}`} className="min-h-12 font-sans text-base sm:text-[13px]" placeholder={rejecting ? "Tell the maker what to change" : "Optional when approving"} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2 [&>button]:h-11 [&>button]:flex-1 sm:[&>button]:h-8 sm:[&>button]:flex-none">
        {!rejecting ? <><Button variant="primary" disabled={busy || needStepUp} title={needStepUp ? "Enter an authenticator code first" : undefined} onClick={() => decide(true)}><Check size={13} aria-hidden />Approve</Button><Button disabled={busy} onClick={() => setRejecting(true)}><X size={13} aria-hidden />Reject</Button></>
          : <><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => decide(false)}><X size={13} aria-hidden />Confirm reject</Button><Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button></>}
      </div>
    </div>)}
    <ErrorNote msg={error} />
  </Card>;
}
