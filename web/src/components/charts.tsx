import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useGet } from "../lib/api";

/** Recharts writes colours as SVG attributes, where CSS variables do not resolve. Read the theme values instead. */
export function useChartColors() {
  const { data: me } = useGet<any>("/me");
  const css = (v: string, d: string) => { try { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || d; } catch { return d; } };
  return { primary: me?.theme?.primary ?? css("--brand-primary", "#1d4ed8"), accent: me?.theme?.accent ?? css("--brand-accent", "#f59e0b"), grid: css("--border", "#e2e8f0"), muted: css("--muted", "#64748b"), ok: css("--ok", "#15803d"), bad: css("--bad", "#b91c1c"), warn: css("--warn", "#b45309") };
}
export type ChartColor = "primary" | "accent" | "ok" | "bad" | "warn" | "muted";
export type Series = { key: string; label: string; color?: ChartColor };
type Common = { data: any[]; x: string; series: Series[]; height?: number; ariaLabel: string; xFormat?: (v: any) => string; yFormat?: (v: number) => string; interval?: number };

export const tooltipStyle = { contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "var(--fg)" } };
const axisTick = (fill: string) => ({ fontSize: 11, fill });

function Frame({ height, ariaLabel, children }: { height: number; ariaLabel: string; children: React.ReactElement }) {
  return <div style={{ height }} role="img" aria-label={ariaLabel}><ResponsiveContainer>{children}</ResponsiveContainer></div>;
}
function useAxes({ x, xFormat, yFormat, interval }: Common) {
  const c = useChartColors();
  return { c, parts: [
    <CartesianGrid key="g" stroke={c.grid} vertical={false} />,
    <XAxis key="x" dataKey={x} tick={axisTick(c.muted)} tickFormatter={xFormat} interval={interval} />,
    <YAxis key="y" tick={axisTick(c.muted)} width={48} tickFormatter={yFormat} />,
  ] };
}
const fmtTip = (series: Series[], yFormat?: (v: number) => string) => (v: any, name: any) => [yFormat ? yFormat(Number(v)) : v, series.find((s) => s.key === name)?.label ?? name];

/** Bar chart in the bank theme. */
export function ThemedBarChart(p: Common) {
  const { c, parts } = useAxes(p);
  return <Frame height={p.height ?? 208} ariaLabel={p.ariaLabel}><BarChart data={p.data}>{parts}<Tooltip {...tooltipStyle} formatter={fmtTip(p.series, p.yFormat)} />
    {p.series.map((s, n) => <Bar key={s.key} dataKey={s.key} fill={c[s.color ?? (n ? "accent" : "primary")]} radius={[3, 3, 0, 0]} />)}</BarChart></Frame>;
}
/** Area chart in the bank theme. */
export function ThemedAreaChart(p: Common) {
  const { c, parts } = useAxes(p);
  return <Frame height={p.height ?? 208} ariaLabel={p.ariaLabel}><AreaChart data={p.data}>{parts}<Tooltip {...tooltipStyle} formatter={fmtTip(p.series, p.yFormat)} />
    {p.series.map((s, n) => { const col = c[s.color ?? (n ? "accent" : "primary")]; return <Area key={s.key} type="monotone" dataKey={s.key} stroke={col} fill={col} fillOpacity={0.15} strokeWidth={1.5} />; })}</AreaChart></Frame>;
}
/** Line chart in the bank theme. */
export function ThemedLineChart(p: Common) {
  const { c, parts } = useAxes(p);
  return <Frame height={p.height ?? 208} ariaLabel={p.ariaLabel}><LineChart data={p.data}>{parts}<Tooltip {...tooltipStyle} formatter={fmtTip(p.series, p.yFormat)} />
    {p.series.map((s, n) => <Line key={s.key} type="monotone" dataKey={s.key} stroke={c[s.color ?? (n ? "accent" : "primary")]} strokeWidth={2} dot={false} />)}</LineChart></Frame>;
}
/** Tiny trend line for KPI cards. */
export function Sparkline({ data, k, color = "primary", label }: { data: any[]; k: string; color?: ChartColor; label: string }) {
  const c = useChartColors(); const col = c[color];
  return <div className="h-full" role="img" aria-label={`${label} trend: ${data.map((d) => d[k]).join(", ")}`}><ResponsiveContainer><AreaChart data={data} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}><Area type="monotone" dataKey={k} stroke={col} fill={col} fillOpacity={0.15} strokeWidth={1.5} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div>;
}
