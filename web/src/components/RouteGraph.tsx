import { useEffect, useMemo } from "react";
import { Background, Handle, useNodesInitialized, useReactFlow, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { RAIL_LABEL, type Rail } from "@b2b/shared";
import { usd } from "../lib/utils";
import { cn } from "../lib/utils";
import { Card, Table } from "./ui";
import { EmptyState, StatusDot } from "./kit";
import { routeView, type RouteOptionView } from "./trace";

type RailData = ReturnType<typeof routeView>[number];
const railName = (r: string) => RAIL_LABEL[r as Rail] ?? r;
const mins = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} day`);

function SourceNode({ data }: NodeProps<Node<{ amount: number; label: string }>>) {
  return <div className="w-44 rounded-lg border-2 border-primary bg-surface px-3 py-2 text-fg shadow-sm"><div className="text-[11px] font-medium text-muted">Payment</div><div className="text-sm font-semibold tabular-nums">{usd(data.amount)}</div><div className="truncate text-[11px] text-muted">{data.label}</div>
    <Handle type="source" position={Position.Right} className="!bg-primary" /></div>;
}
function RailNode({ data }: NodeProps<Node<RailData>>) {
  return <div className={cn("w-64 rounded-lg border-2 bg-surface px-3 py-2 text-fg shadow-sm", data.kind === "chosen" ? "border-ok" : data.kind === "eligible" ? "border-border" : "border-dashed border-bad/60 opacity-90")}>
    <Handle type="target" position={Position.Left} className="!bg-muted" />
    <div className="flex items-center gap-2"><span className="text-[13px] font-semibold">{railName(data.rail)}</span><span className="ml-auto"><StatusDot tone={data.kind === "chosen" ? "ok" : data.kind === "eligible" ? "warn" : "bad"} label={data.kind === "chosen" ? "Chosen" : data.kind === "eligible" ? `Score ${data.score}` : "Ruled out"} /></span></div>
    <div className="mt-0.5 text-[11px] text-muted">Fee {usd(data.feeUsd)}, settles in {mins(data.settleMinutes)}</div>
    <div className={cn("mt-1 text-[11px]", data.kind === "ineligible" ? "text-bad" : "text-muted")}>{data.verdict}</div>
  </div>;
}
/** Fit once React Flow has measured the custom nodes, so the graph opens at a readable zoom. */
function FitWhenReady() {
  const ready = useNodesInitialized(); const { fitView } = useReactFlow();
  useEffect(() => { if (ready) void fitView({ padding: 0.15, maxZoom: 1 }); }, [ready, fitView]);
  return null;
}
const nodeTypes = { source: SourceNode, rail: RailNode };

/** Candidate rails from the deterministic router, and why each one won or lost. */
export function RouteGraph({ options, chosen, amount, supplier }: { options: RouteOptionView[] | undefined; chosen: string | null; amount: number; supplier?: string }) {
  const rows = useMemo(() => routeView(options ?? [], chosen), [options, chosen]);
  const { nodes, edges } = useMemo(() => {
    const gapY = 124; const top = -((rows.length - 1) * gapY) / 2;
    const nodes: Node[] = [{ id: "pay", type: "source", position: { x: 0, y: -28 }, data: { amount, label: supplier ? `to ${supplier}` : "to supplier" }, draggable: false },
      ...rows.map((r, n) => ({ id: r.rail, type: "rail", position: { x: 300, y: top + n * gapY - 36 }, data: r, draggable: false }))];
    const color = (k: string) => (k === "chosen" ? "var(--ok)" : k === "eligible" ? "var(--muted)" : "var(--bad)");
    const edges: Edge[] = rows.map((r) => ({ id: `e-${r.rail}`, source: "pay", target: r.rail, animated: r.kind === "chosen", label: r.kind === "chosen" ? "route" : r.kind === "eligible" ? `score ${r.score}` : "blocked",
      style: { stroke: color(r.kind), strokeWidth: r.kind === "chosen" ? 2.5 : 1.5, strokeDasharray: r.kind === "ineligible" ? "5 4" : undefined },
      labelStyle: { fontSize: 11, fill: "var(--muted)" }, labelBgStyle: { fill: "var(--surface)" }, markerEnd: { type: MarkerType.ArrowClosed, color: color(r.kind) } }));
    return { nodes, edges };
  }, [rows, amount, supplier]);
  if (!rows.length) return <Card title="Routing graph"><EmptyState title="No routing yet" body="The router has not scored rails for this payment. It runs after the invoice matches." /></Card>;
  const summary = `${rows.length} rails scored. ${chosen ? `${railName(chosen)} chosen.` : "No rail chosen."}`;
  return <Card title="Routing graph" action={<span className="flex gap-3"><StatusDot tone="ok" label="Chosen" /><StatusDot tone="warn" label="Eligible" /><StatusDot tone="bad" label="Ruled out" /></span>}>
    <p className="mb-2 text-xs text-muted">{summary} The router scores cost, speed and supplier preference after hard filters. The graph is read only.</p>
    <div className="h-[380px] rounded-lg border border-border bg-bg" role="img" aria-label={`Routing graph. ${summary}`}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }} minZoom={0.3} colorMode="system">
        <Background gap={20} color="var(--border)" />
        <FitWhenReady />
      </ReactFlow>
    </div>
    <details className="mt-2"><summary className="cursor-pointer text-xs text-muted">Show as table</summary>
      <Table head={["Rail", "Result", "Why"]}>{rows.map((r) => <tr key={r.rail}><td>{railName(r.rail)}</td><td>{r.kind === "chosen" ? "Chosen" : r.kind === "eligible" ? `Eligible, ${r.score}` : "Not eligible"}</td><td className="text-muted">{r.why.join(", ")}</td></tr>)}</Table></details>
  </Card>;
}
