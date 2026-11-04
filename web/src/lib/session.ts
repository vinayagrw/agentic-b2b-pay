import type { QueryClient } from "@tanstack/react-query";

export type MeLike = { operator: boolean } | null;
/**
 * After POST /auth/login. The ["me"] query is inactive on /login and still caches null from the redirect, so a plain
 * invalidateQueries() would not refetch it and the route guard would bounce back to /login. Refetch it into the cache
 * first, then pick the landing page from the server's answer.
 */
export async function afterLogin(qc: QueryClient, fetchMe: () => Promise<MeLike>, navigate: (to: string, o?: { replace?: boolean }) => void) {
  await qc.cancelQueries({ queryKey: ["me"] });
  const me = await qc.fetchQuery({ queryKey: ["me"], queryFn: fetchMe, staleTime: 0 });
  await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  const to = !me ? "/login" : me.operator ? "/operator" : "/app";
  navigate(to, { replace: true });
  return to;
}
