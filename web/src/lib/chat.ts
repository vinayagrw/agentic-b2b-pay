/** Reads the stored Slack Block Kit and Teams Adaptive Card payloads into one simple shape for the preview page. */
export type ChatButton = { kind: "approve" | "reject" | "open"; label: string; token?: string; url?: string };
export type ChatView = { title: string; fields: { label: string; value: string }[]; state: string | null; buttons: ChatButton[] };

export function readSlack(card: any): ChatView {
  const blocks: any[] = card?.blocks ?? [];
  const title = blocks.find((b) => b.type === "header")?.text?.text ?? "";
  const fields = (blocks.find((b) => b.type === "section")?.fields ?? []).map((f: any) => { const [l, ...v] = String(f.text).split("\n"); return { label: l.replace(/\*/g, ""), value: v.join(" ") }; });
  const state = blocks.find((b) => b.type === "context")?.elements?.[0]?.text ?? null;
  const buttons = (blocks.find((b) => b.type === "actions")?.elements ?? []).map((e: any): ChatButton => ({ kind: e.action_id, label: e.text?.text ?? e.action_id, token: e.value, url: e.url }));
  return { title, fields, state, buttons };
}
export function readTeams(card: any): ChatView {
  const c = card?.attachments?.[0]?.content ?? {}; const body: any[] = c.body ?? [];
  const title = body[0]?.text ?? "";
  const fields = (body.find((b) => b.type === "FactSet")?.facts ?? []).map((f: any) => ({ label: f.title, value: f.value }));
  const state = body.length > 2 ? body[body.length - 1]?.text ?? null : null;
  const buttons = (c.actions ?? []).map((a: any): ChatButton => a.type === "Action.OpenUrl" ? { kind: "open", label: a.title, url: a.url } : { kind: a.data?.action, label: a.title, token: a.data?.token });
  return { title, fields, state, buttons };
}
export const readCard = (provider: string, card: any) => (provider === "slack" ? readSlack(card) : readTeams(card));
/** The in-app path for an Open in app link, so the preview stays in this tab. */
export const appPath = (url?: string) => { if (!url) return "/app/approvals"; try { const u = new URL(url); return u.pathname + u.search; } catch { return "/app/approvals"; } };
