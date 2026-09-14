"use client";

import { useMemo } from "react";
import { Chart, type ChartOption } from "@/components/ui/chart";
import { AXIS, TOOLTIP, fmtNum, fmtPct, axisLabel } from "@/lib/echarts";

export type CeilingPoint = {
  ts: string | null;
  peak: number;
  p50?: number;
  pctOfLimit: number;
  activeSubBuckets?: number;
};

/**
 * One ceiling, over time.
 *
 * Every bar is the PEAK sub-bucket inside that display bucket - peak per minute
 * for RPM/TPM, peak per second for QPS - because that is the granularity the
 * limit is actually enforced at. It is never an average: averaging the real
 * incident in this account turns a 409 QPS breach into ~7.
 *
 * The y-axis is linear and scaled to max(peak, limit), so a large breach pushes
 * the limit line down near the axis. That is deliberate rather than a defect: it
 * shows honestly that the ceiling was cleared by 20x instead of flattering the
 * chart with a log scale.
 */
export function CeilingTrend({
  points,
  limit,
  unit,
  window,
  warnPct,
  pagePct,
  height = 170,
  showP50 = true,
  valueFormatter = fmtNum,
}: {
  points: CeilingPoint[];
  limit: number;
  unit: string;
  window: string;
  warnPct: number;
  pagePct: number;
  height?: number;
  showP50?: boolean;
  valueFormatter?: (n: number | null | undefined) => string;
}) {
  const worst = useMemo(() => {
    if (points.length === 0) return null;
    return points.reduce((a, b) => (b.pctOfLimit > a.pctOfLimit ? b : a));
  }, [points]);

  const option = useMemo<ChartOption>(() => {
    const peakMax = Math.max(0, ...points.map((p) => p.peak));
    // Keep the limit line on-canvas even when nothing came close to it.
    const yMax = Math.max(peakMax, limit) * 1.08;

    return {
      grid: { left: 52, right: 16, top: 10, bottom: 22 },
      tooltip: {
        ...TOOLTIP,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: never) => {
          const p = params as unknown as Array<{ dataIndex: number }>;
          const row = points[p[0]?.dataIndex ?? 0];
          if (!row) return "";
          const lines = [
            `<b>${axisLabel(row.ts, window)}</b>`,
            `peak       ${valueFormatter(row.peak)} ${unit}`,
          ];
          if (row.p50 !== undefined) lines.push(`p50        ${valueFormatter(row.p50)} ${unit}`);
          lines.push(`limit      ${valueFormatter(limit)} ${unit}`);
          lines.push(`of limit   ${fmtPct(row.pctOfLimit, 1)}`);
          if (row.activeSubBuckets !== undefined) {
            lines.push(`active     ${fmtNum(row.activeSubBuckets)}`);
          }
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: points.map((p) => axisLabel(p.ts, window)),
        ...AXIS,
      },
      yAxis: {
        type: "value",
        max: yMax,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => valueFormatter(v) },
      },
      series: [
        {
          name: `Peak ${unit}`,
          type: "bar",
          barMaxWidth: 22,
          data: points.map((p) => ({
            value: p.peak,
            itemStyle: {
              color:
                p.pctOfLimit >= pagePct
                  ? "#ff5a5f"
                  : p.pctOfLimit >= warnPct
                    ? "#ffc53d"
                    : "#4fb8c9",
            },
          })),
          // The ceiling itself. Dashed so it never reads as measured data.
          markLine: {
            silent: true,
            symbol: "none",
            data: [{ yAxis: limit }],
            lineStyle: { color: "#ff5a5f", type: "dashed", width: 1, opacity: 0.75 },
            label: {
              show: true,
              position: "insideEndTop",
              formatter: `limit ${valueFormatter(limit)}`,
              color: "#ff5a5f",
              fontSize: 9,
              fontFamily: "var(--font-mono), monospace",
            },
          },
        },
        ...(showP50 && points.some((p) => p.p50 !== undefined)
          ? [
              {
                name: `p50 ${unit}`,
                type: "line" as const,
                smooth: false,
                symbol: "none",
                data: points.map((p) => p.p50 ?? null),
                lineStyle: { color: "#8e9bb0", width: 1, type: "solid" as const },
                z: 3,
              },
            ]
          : []),
      ],
    };
  }, [points, limit, unit, window, warnPct, pagePct, showP50, valueFormatter]);

  return (
    <>
      <Chart option={option} height={height} empty={points.length === 0} />
      {worst && (
        <div className="mt-2 border-t border-line-faint pt-2 font-mono text-[10px] text-ink-faint">
          Worst bucket:{" "}
          <span className="text-ink">{axisLabel(worst.ts, window)}</span> peaked at{" "}
          <span className="text-ink">
            {valueFormatter(worst.peak)} {unit}
          </span>{" "}
          ={" "}
          <span
            style={{
              color:
                worst.pctOfLimit >= pagePct
                  ? "#ff5a5f"
                  : worst.pctOfLimit >= warnPct
                    ? "#ffc53d"
                    : "#2fd8a6",
            }}
          >
            {fmtPct(worst.pctOfLimit, 1)}
          </span>{" "}
          of the ceiling
          {worst.pctOfLimit >= 100 && (
            <span className="text-st-critical"> — breached, requests were throttled</span>
          )}
          .
        </div>
      )}
    </>
  );
}

/**
 * Empty-state notice used where a ceiling has no observable traffic at all.
 * Explicit wording matters: a blank chart must not be read as "zero saturation"
 * when the truth is "nothing was measured in this window".
 */
export function NoCeilingData({ what }: { what: string }) {
  return (
    <div className="grid place-items-center border border-dashed border-line-faint bg-inset/40 py-8">
      <span className="label-micro text-center">{what}</span>
    </div>
  );
}
