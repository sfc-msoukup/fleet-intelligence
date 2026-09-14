"use client";

/**
 * Tree-shaken ECharts. The `echarts/core` entry ships NO renderer, so
 * CanvasRenderer must be registered explicitly or charts render blank.
 */
import * as echarts from "echarts/core";
import {
  LineChart,
  BarChart,
  HeatmapChart,
  GaugeChart,
  CustomChart,
  PieChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
  VisualMapComponent,
  GraphicComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GaugeChart,
  CustomChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
  VisualMapComponent,
  GraphicComponent,
  CanvasRenderer,
]);

export { echarts };

/** Shared axis/tooltip styling so every chart reads as one instrument family. */
export const AXIS = {
  axisLine: { lineStyle: { color: "#1f2a36" } },
  axisTick: { show: false },
  axisLabel: {
    color: "#6b7a8b",
    fontSize: 10,
    fontFamily: "var(--font-mono), monospace",
  },
  splitLine: { lineStyle: { color: "#161e28", type: "solid" as const } },
};

export const TOOLTIP = {
  backgroundColor: "#0e141c",
  borderColor: "#2c3a48",
  borderWidth: 1,
  padding: [6, 9] as [number, number],
  textStyle: {
    color: "#e6edf5",
    fontSize: 11,
    fontFamily: "var(--font-mono), monospace",
  },
  extraCssText: "border-radius:3px;box-shadow:0 8px 24px rgba(0,0,0,.5);",
};

export const GRID = { left: 44, right: 16, top: 16, bottom: 24, containLabel: false };

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function fmtPct(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  return `${p.toFixed(digits)}%`;
}

/** Compact UTC label for chart axes. Inputs are always ISO strings. */
export function axisLabel(iso: string | null, window: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (window === "60m") {
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  if (window === "24h") {
    return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  }
  // A 365-day window can contain the same month/day twice, so M/D alone would
  // render two distinct buckets with an identical label. Shorter windows cannot
  // collide and stay on the compact form.
  if (window === "365d") {
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`;
  }
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
