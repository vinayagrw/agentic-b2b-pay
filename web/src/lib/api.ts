import { useEffect, useRef, useState } from "react";
import { useSSE } from "./stream";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { rateLimitText, toast } from "./toast";

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export async function api<T = any>(path: string, body?: unknown, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? (body === undefined ? "GET" : "POST");
  const r = await fetch(`/api${path}`, { method, credentials: "include", headers: body === undefined ? opts.headers : { "content-type": "application/json", ...opts.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get("content-type") ?? "";
  const j: any = ct.includes("json") ? await r.json().catch(() => ({})) : await r.text();
  if (r.status === 429) toast(rateLimitText(r.headers.get("retry-after")));
  if (!r.ok) throw new ApiError(r.status, j?.error ?? `HTTP ${r.status}`);
  return j as T;
}
export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: false } } });

export type Me = { user: { id: string; name: string; role: string; tenantId: string | null; email: string; customRoleId?: string | null }; operator: boolean; tenant: Tenant; theme: Branding; tenants: Tenant[]; llmMode: string; permissions?: string[]; roleName?: string; approveLimit?: number | null };
export type Branding = { name: string; logo: string | null; primary: string; accent: string };
export type Tenant = { id: string; kind: "bank" | "client"; parentId: string | null; name: string; branding: Branding; railSettings: Record<string, { provider: string; env: "sandbox" | "live" }>; createdAt: string };

export const useMe = () => useQuery<Me | null>({ queryKey: ["me"], queryFn: () => api<Me>("/me").catch((e) => { if (e instanceof ApiError && e.status === 401) return null; throw e; }) });
export const useAppState = () => useQuery<any>({ queryKey: ["state"], queryFn: () => api("/state") });
export const useGet = <T = any,>(path: string, enabled = true) => useQuery<T>({ queryKey: [path], queryFn: () => api<T>(path), enabled });

/** One SSE stream for the app. Any server change refreshes cached queries. Built on useSSE. */
export function useLiveEvents() {
  const qc = useQueryClient();
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  const status = useSSE("/api/events", ["hello", "change"], (m) => {
    if (m.event !== "change" || t.current) return;
    t.current = setTimeout(() => { t.current = null; qc.invalidateQueries(); }, 150);
  });
  return status === "open";
}

/** Runs a mutating call with shared busy and error state, then refreshes. */
export function useAct() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError("");
    try { const r = await fn(); await qc.invalidateQueries(); return r; } catch (e: any) { setError(e.message); return undefined; } finally { setBusy(false); }
  };
  return { run, busy, error, setError };
}
