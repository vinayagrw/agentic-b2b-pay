/** One row on the trace timeline. Lifecycle rows come from status changes, audit rows from the evidence chain. */
export type TraceEvent = { at: string; kind: "lifecycle" | "audit"; title: string; detail?: string; source?: string; status?: string };

/** Merge payment status history and audit records into one list, oldest first, without exact duplicates. */
export function buildTrace(timeline: { at: string; status: string; source?: string; detail?: string }[] = [], evidence: { id?: string; event: string; createdAt: string; actor?: string }[] = []): TraceEvent[] {
  const rows: TraceEvent[] = [
    ...timeline.filter((t) => t.at).map((t) => ({ at: String(t.at), kind: "lifecycle" as const, title: t.status.replaceAll("_", " "), status: t.status, detail: t.detail, source: t.source })),
    ...evidence.filter((e) => e.createdAt).map((e) => ({ at: e.createdAt, kind: "audit" as const, title: e.event.replaceAll(".", " ").replaceAll("_", " "), source: e.actor })),
  ];
  const seen = new Set<string>();
  return rows.filter((r) => { const k = `${r.kind}|${r.at}|${r.title}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === "lifecycle" ? -1 : 1));
}

/** Gap between two ISO times in a short human form. */
export function gap(a: string, b: string): string {
  const ms = Math.max(0, new Date(b).getTime() - new Date(a).getTime());
  if (!Number.isFinite(ms) || ms === 0) return "";
  return ms < 1000 ? `${ms} ms later` : ms < 60_000 ? `${Math.round(ms / 1000)} s later` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min later` : `${(ms / 3_600_000).toFixed(1)} h later`;
}

export type RouteOptionView = { rail: string; eligible: boolean; feeUsd: number; settleMinutes: number; score: number; why: string[] };
export type RouteNodeKind = "chosen" | "eligible" | "ineligible";
/** Classify each candidate rail for the routing graph, best score first. */
export function routeView(options: RouteOptionView[], chosen: string | null) {
  return [...options].sort((a, b) => Number(b.rail === chosen) - Number(a.rail === chosen) || b.score - a.score).map((o) => ({
    ...o, kind: (o.rail === chosen ? "chosen" : o.eligible ? "eligible" : "ineligible") as RouteNodeKind,
    verdict: o.rail === chosen ? "Chosen, highest score" : o.eligible ? `Eligible, scored ${o.score}, lower than the winner` : `Not eligible: ${o.why.join(", ")}`,
  }));
}
