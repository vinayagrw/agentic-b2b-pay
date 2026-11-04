import type { Me } from "./api";

/** True when the signed in user holds the permission. Operators hold every permission the BFF grants them. */
export function can(me: Pick<Me, "permissions"> | null | undefined, perm: string): boolean {
  return !!me?.permissions?.includes(perm);
}
export const canAny = (me: Pick<Me, "permissions"> | null | undefined, perms: string[]) => perms.some((p) => can(me, p));

export type StepUpStatus = { enrolled: boolean; thresholdUsd: number; fresh: boolean; freshUntil: string | null };
/** True when approving this amount needs a fresh authenticator code first. The server enforces the same rule. */
export const stepUpNeeded = (amount: number, s: StepUpStatus | undefined) => !!s && amount > s.thresholdUsd && !s.fresh;
