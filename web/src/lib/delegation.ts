/** Approval hand over and resubmit helpers. Plain logic, tested without a browser. */
export type Delegation = { id: string; fromUser: string; fromName: string; toUser: string; toName: string; startsOn: string; endsOn: string; note: string; state: "active" | "upcoming" | "ended" | "revoked" };
export type DelegationList = { delegations: Delegation[]; candidates: { id: string; name: string }[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Why the hand over form cannot be sent yet, or null when it can. Mirrors the server checks. */
export function delegationBlock(x: { toUserId: string; startsOn: string; endsOn: string }, meId: string, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!x.toUserId) return "Pick who will approve for you.";
  if (x.toUserId === meId) return "You cannot hand approvals to yourself.";
  if (!DATE.test(x.startsOn) || !DATE.test(x.endsOn)) return "Pick a start and end date.";
  if (x.endsOn < x.startsOn) return "The end date must be on or after the start date.";
  if (x.endsOn < today) return "The end date is in the past.";
  if ((Date.parse(x.endsOn) - Date.parse(x.startsOn)) / 864e5 > 90) return "A hand over can last 90 days at most.";
  return null;
}
export const DELEGATION_STATE: Record<Delegation["state"], { text: string; tone: "ok" | "warn" | "neutral" | "bad" }> = {
  active: { text: "Active", tone: "ok" }, upcoming: { text: "Starts later", tone: "warn" }, ended: { text: "Ended", tone: "neutral" }, revoked: { text: "Stopped", tone: "neutral" },
};
/** Why the requester cannot send a rejected order again, or null when they can. */
export function resubmitBlock(item: { status: string; canResubmit?: boolean }, note: string): string | null {
  if (item.status !== "rejected") return "Only a rejected order can be sent again.";
  if (!item.canResubmit) return "Only the person who asked for this order can send it again.";
  if (note.trim().length < 3) return "Say what changed, in a few words.";
  return null;
}
/** One line for a hand over, written from the viewer side. */
export function delegationLine(d: Delegation, meId: string): string {
  const from = d.fromUser === meId ? "You" : d.fromName; const to = d.toUser === meId ? "you" : d.toName;
  return `${from} to ${to}, ${d.startsOn} to ${d.endsOn}${d.note ? `. ${d.note}` : ""}`;
}
/** Badge text for an approval card handled for someone else, or null. */
export function handledForBadge(p: { status: string; delegatedFrom?: { userId: string; name: string } | null }): string | null {
  return p.delegatedFrom && p.status === "pending_approval" ? `Approving for ${p.delegatedFrom.name}` : null;
}
