import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { tooltipStyle, useChartColors } from "./charts";
import type { ChartSpec } from "../lib/copilot";

export type ViewType = "bar" | "line" | "area" | "donut" | "stacked";
const PALETTE = ["primary", "accent", "ok", "warn", "bad", "muted"] as const;

/** Wide rows for recharts. With a series column each series value becomes its own key. */
export function pivot(s: ChartSpec) {
  if (!s.series) return { data: s.rows, keys: s.y };
  const by = new Map<string, Record<string, string | number>>(); const keys: string[] = [];
  for (const r of s.rows) { const x = String(r[s.x]); const k = String(r[s.series]); if (!keys.includes(k)) keys.push(k); const o = by.get(x) ?? { [s.x]: x }; o[k] = Number(o[k] ?? 0) + Number(r[s.y[0]] ?? 0); by.set(x, o); }
  return { data: [...by.values()].map((o) => Object.fromEntries([[s.x, o[s.x]], ...keys.map((k) => [k, o[k] ?? 0])])), keys: keys.slice(0, 8) };
}

/** Renders one chart spec in the bank theme. Colours come from useChartColors so dark mode works. */
export default function SpecChart({ spec, type, height = 220 }: { spec: ChartSpec; type: ViewType; height?: number }) {
  const c = useChartColors(); const col = (n: number) => c[PALETTE[n % PALETTE.length]];
  const { data, keys } = pivot(spec);
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100));
  const tick = { fontSize: 11, fill: c.muted };
  const axes = [<CartesianGrid key="g" stroke={c.grid} vertical={false} />, <XAxis key="x" dataKey={spec.x} tick={tick} />, <YAxis key="y" tick={tick} width={52} tickFormatter={fmt} />, <Tooltip key="t" {...tooltipStyle} formatter={(v: any) => fmt(Number(v))} />, ...(keys.length > 1 ? [<Legend key="l" wrapperStyle={{ fontSize: 11 }} />] : [])];
  let chart: React.ReactElement;
  if (type === "donut") {
    const pie = data.map((r) => ({ name: String(r[spec.x]), value: keys.reduce((a, k) => a + Number(r[k] ?? 0), 0) })).filter((r) => r.value > 0);
    chart = <PieChart><Tooltip {...tooltipStyle} formatter={(v: any) => fmt(Number(v))} /><Legend wrapperStyle={{ fontSize: 11 }} /><Pie data={pie} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" isAnimationActive={false}>{pie.map((_, n) => <Cell key={n} fill={col(n)} />)}</Pie></PieChart>;
  } else if (type === "line") chart = <LineChart data={data}>{axes}{keys.map((k, n) => <Line key={k} type="monotone" dataKey={k} stroke={col(n)} strokeWidth={2} dot={false} isAnimationActive={false} />)}</LineChart>;
  else if (type === "area") chart = <AreaChart data={data}>{axes}{keys.map((k, n) => <Area key={k} type="monotone" dataKey={k} stroke={col(n)} fill={col(n)} fillOpacity={0.15} isAnimationActive={false} />)}</AreaChart>;
  else chart = <BarChart data={data}>{axes}{keys.map((k, n) => <Bar key={k} dataKey={k} fill={col(n)} stackId={type === "stacked" ? "s" : undefined} isAnimationActive={false} />)}</BarChart>;
  return <div style={{ height }} role="img" aria-label={`${spec.title}: ${type} chart of ${keys.join(", ")} by ${spec.x}`}><ResponsiveContainer>{chart}</ResponsiveContainer></div>;
}
