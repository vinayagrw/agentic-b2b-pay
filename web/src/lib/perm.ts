import type { Me } from "./api";

/** True when the signed in user holds the permission. Operators hold every permission the BFF grants them. */
export function can(me: Pick<Me, "permissions"> | null | undefined, perm: string): boolean {
  return !!me?.permissions?.includes(perm);
}
export const canAny = (me: Pick<Me, "permissions"> | null | undefined, perms: string[]) => perms.some((p) => can(me, p));
