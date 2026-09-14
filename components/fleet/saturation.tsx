"use client";

import { useMemo } from "react";
import { Chart, Panel, SourceBadge } from "@/components/ui/chart";
import { AXIS, TOOLTIP, fmtNum, fmtPct } from "@/lib/echarts";

/**
 * Saturation gauge. ECharts `gauge` with a progress arc, which is the strongest
 * reason to take ECharts over Recharts here - a generic RadialBar reads like
 * every other dashboard.
 *
 * Thresholds are 60% warn / 80% page rather than 90-95%, because Snowflake's
 * limiter is a documented sliding-window counter that "could overestimate the
 * rate of requests" on spiky traffic, and agent fan-out is inherently spiky.
 * Nominal headroom overstates real headroom, so the alert line is derated.
 */
export function SaturationGauge({
  label,
  pct,
  peak,
  limit,
  unit,
  p50,
  p99,
  source,
  warnPct = 60,
  pagePct = 80,
  note,
  height = 168,
}: {
  label: string;
  pct: number;
  peak: number;
  limit: number;
  unit: string;
  p50?: number;
  p99?: number;
  source?: string | null;
  warnPct?: number;
  pagePct?: number;
  note?: string;
  height?: number;
}) {
  const clamped = Math.min(pct, 100);
  const over = pct > 100;
  const color = pct >= pagePct ? "#ff5a5f" : pct >= warnPct ? "#ffc53d" : "#2fd8a6";

  const option = useMemo(
    () => ({
      series: [
        {
          type: "gauge",
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: 100,
          splitNumber: 5,
          radius: "94%",
          center: ["50%", "62%"],
          progress: {
            show: true,
            width: 9,
            roundCap: false,
            itemStyle: { color, shadowBlur: 12, shadowColor: color },
          },
          pointer: { show: false },
          axisLine: { lineStyle: { width: 9, color: [[1, "#161e28"]] } },
          axisTick: {
            distance: -13,
            length: 4,
            lineStyle: { color: "#2c3a48", width: 1 },
          },
          splitLine: {
            distance: -15,
            length: 7,
            lineStyle: { color: "#2c3a48", width: 1 },
          },
          axisLabel: { show: false },
          anchor: { show: false },
          title: { show: false },
          detail: {
            valueAnimation: true,
            offsetCenter: [0, "-2%"],
            fontSize: 22,
            fontFamily: "var(--font-mono), monospace",
            color: "#e6edf5",
            formatter: () => (over ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`),
          },
          data: [{ value: clamped }],
        },
      ],
      // threshold markers drawn as a second, thin ring
      graphic: [],
    }),
    [clamped, color, over, pct],
  );

  return (
    <div className="panel flex flex-col px-3 py-2.5">
      <div className="flex items-start gap-1.5">
        <span className="label-micro flex-1 leading-snug">{label}</span>
        {source && <SourceBadge source={source} />}
      </div>

      <Chart option={option} height={height} />

      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px]">
        <div className="flex justify-between">
          <dt className="text-ink-faint">peak</dt>
          <dd className="text-ink-hi">{fmtNum(peak)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-faint">limit</dt>
          <dd className="text-ink">{fmtNum(limit)}</dd>
        </div>
        {p50 !== undefined && (
          <div className="flex justify-between">
            <dt className="text-ink-faint">p50/min</dt>
            <dd className="text-ink">{fmtNum(p50)}</dd>
          </div>
        )}
        {p99 !== undefined && (
          <div className="flex justify-between">
            <dt className="text-ink-faint">p99/min</dt>
            <dd className="text-ink">{fmtNum(p99)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-1 border-t border-line-faint pt-1 font-mono text-[9px] leading-snug text-ink-faint">
        {unit}
        {over && (
          <span className="ml-1 text-st-critical">
            · {fmtPct(pct, 0)} of ceiling — sustained breach
          </span>
        )}
        {note && <div className="mt-0.5">{note}</div>}
      </div>
    </div>
  );
}

/**
 * Interpretation helper. Peak alone does not tell you what to DO, and peak vs
 * median tells you which of two very different fixes applies. Utilisation is
 * checked before shape, so a low-utilisation flat profile is never reported as
 * needing a limit increase.
 */
export function SaturationReading({
  peakPct,
  p50,
  peak,
  warnPct = 60,
}: {
  peakPct: number;
  p50: number;
  peak: number;
  warnPct?: number;
}) {
  if (peak === 0) {
    return <span className="text-ink-faint">No traffic in window</span>;
  }
  if (peakPct < warnPct) {
    return (
      <span className="text-st-nominal">
        Ample headroom — peak reached {peakPct.toFixed(1)}% of the ceiling.
      </span>
    );
  }
  const ratio = p50 > 0 ? peak / p50 : Infinity;
  if (ratio > 5) {
    return (
      <span className="text-st-degraded">
        Bursty — peak is {ratio.toFixed(0)}x the median minute. Smooth or queue the client;
        raising the limit would mostly buy idle capacity.
      </span>
    );
  }
  return (
    <span className="text-st-critical">
      Structural — the median minute is already near the ceiling, so this needs a limit increase
      rather than client-side smoothing.
    </span>
  );
}

/** Small horizontal bar list. Used for top users / roles. */
export function BarList({
  rows,
  valueKey,
  labelKey,
  secondary,
  color = "#7ad7f0",
}: {
  rows: Array<Record<string, unknown>>;
  valueKey: string;
  labelKey: string;
  secondary?: (r: Record<string, unknown>) => string;
  color?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  if (rows.length === 0) {
    return <div className="label-micro py-6 text-center">No data in window</div>;
  }
  return (
    <ul className="flex flex-col">
      {rows.map((r, i) => {
        const v = Number(r[valueKey]) || 0;
        return (
          <li
            key={`${String(r[labelKey])}-${i}`}
            className="group relative flex items-center gap-2 border-b border-line-faint px-1 py-1.5 last:border-0"
          >
            <span
              className="absolute inset-y-0 left-0 -z-0 opacity-15 transition-opacity group-hover:opacity-25"
              style={{ width: `${(v / max) * 100}%`, background: color }}
            />
            <span className="relative z-10 min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
              {String(r[labelKey])}
            </span>
            {secondary && (
              <span className="relative z-10 shrink-0 font-mono text-[10px] text-ink-faint">
                {secondary(r)}
              </span>
            )}
            <span className="relative z-10 w-12 shrink-0 text-right font-mono text-[11px] text-ink-hi">
              {fmtNum(v)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export { AXIS, TOOLTIP };
