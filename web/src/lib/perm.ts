import type { Me } from "./api";

/** True when the signed in user holds the permission. Operators hold every permission the BFF grants them. */
export function can(me: Pick<Me, "permissions"> | null | undefined, perm: string): boolean {
  return !!me?.permissions?.includes(perm);
}
export const canAny = (me: Pick<Me, "permissions"> | null | undefined, perms: string[]) => perms.some((p) => can(me, p));

export type StepUpStatus = { enrolled: boolean; thresholdUsd: number; fresh: boolean; freshUntil: string | null };
/** True when approving this amount needs a fresh authenticator code first. The server enforces the same rule. */
export const stepUpNeeded = (amount: number, s: StepUpStatus | undefined) => !!s && amount > s.thresholdUsd && !s.fresh;

/** Plain words shown when a role opens a page it cannot use. */
export const NO_ACCESS: Record<string, string> = {
  "statements.read": "Your role cannot view bank statements. Ask a finance admin for access.",
};
export const noAccessText = (perm: string) => NO_ACCESS[perm] ?? "Your role cannot open this page. Ask an admin for access.";

/** Plain names for permissions the server may name in a 403. */
const PERM_PLAIN: Record<string, string> = {
  "statements.read": "view bank statements", "statements.manage": "import or match bank statements", "erp.vendor_master": "send vendor changes from the ERP",
  "payments.approve": "approve orders", "payments.pay": "pay invoices", "flow.operate": "hold or resubmit invoices", "suppliers.payee_change": "change supplier bank details",
  "audit.read": "read the audit trail", "roles.manage": "manage roles",
};
/** Turns the server's "Role X does not include perm" into a sentence a person can act on. Other messages pass through. */
export function plainForbidden(msg: string): string {
  const m = /^Role (.+) does not include ([\w.]+)$/.exec(msg.trim());
  if (!m) return msg;
  return `Your role (${m[1]}) cannot ${PERM_PLAIN[m[2]] ?? "do this"}. Ask an admin for access.`;
}
