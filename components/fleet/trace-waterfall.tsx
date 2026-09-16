"use client";

import { useMemo } from "react";
import { Chart } from "@/components/ui/chart";
import { TOOLTIP, fmtMs } from "@/lib/echarts";

export type Span = {
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  spanCategory: string;
  startTs: string | null;
  endTs: string | null;
  latencyMs: number | null;
  hasInvalidDuration: boolean;
  stepNumber: number | null;
  modelName: string | null;
  toolStatus: string | null;
  toolStatusDescription: string | null;
  isToolError: boolean;
};

const CAT_COLOR: Record<string, string> = {
  "LLM Planning": "#7ad7f0",
  "LLM Response Generation": "#4fb8c9",
  "Semantic Context": "#c8b88a",
  "SQL Execution": "#d98c6a",
  "SQL Execution (inner)": "#b0765a",
  "Cortex Search": "#8e9bb0",
  "Cortex Analyst": "#5f7d95",
  Skill: "#9db3c4",
  "Chart Generation": "#7e8fa3",
  "Code Execution": "#6d8296",
  "Tool Call": "#5f7d95",
  "Memory Injection": "#4a5f73",
  Agent: "#2c3a48",
  "Agent Wrapper": "#243040",
  "Request Envelope": "#1f2a36",
  Other: "#48545f",
};

/**
 * Trace waterfall. Built with ECharts `custom` series rather than a stacked bar
 * with transparent offsets, because a real waterfall needs each span drawn at an
 * absolute (start, end) with its own depth - the transparent-spacer trick breaks
 * as soon as siblings overlap in time, which is exactly what concurrent tool
 * calls do.
 *
 * Depth comes from walking parent_span_id, so the tree structure is real rather
 * than inferred from ordering.
 */
export function TraceWaterfall({ spans }: { spans: Span[] }) {
  const rows = useMemo(() => {
    if (spans.length === 0) return [];

    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const depthOf = (s: Span, guard = 0): number => {
      if (guard > 24 || !s.parentSpanId) return 0;
      const p = byId.get(s.parentSpanId);
      return p ? depthOf(p, guard + 1) + 1 : 0;
    };

    // Spans whose duration could not be computed are excluded rather than drawn
    // at zero width, which would place them at a meaningless offset.
    const usable = spans.filter(
      (s) => s.startTs && s.endTs && !s.hasInvalidDuration && s.latencyMs !== null,
    );
    if (usable.length === 0) return [];

    const t0 = Math.min(...usable.map((s) => new Date(s.startTs as string).getTime()));

    return usable
      .map((s) => {
        const start = new Date(s.startTs as string).getTime() - t0;
        return {
          span: s,
          depth: depthOf(s),
          start,
          end: start + Math.max(s.latencyMs ?? 0, 1),
        };
      })
      .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  }, [spans]);

  const excluded = spans.filter(
    (s) => s.hasInvalidDuration || s.latencyMs === null || !s.startTs || !s.endTs,
  ).length;

  const option = useMemo(() => {
    const maxEnd = Math.max(1, ...rows.map((r) => r.end));
    return {
      grid: { left: 178, right: 44, top: 8, bottom: 24 },
      xAxis: {
        type: "value",
        min: 0,
        max: maxEnd,
        axisLine: { lineStyle: { color: "#1f2a36" } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "#161e28" } },
        axisLabel: {
          color: "#6b7a8b",
          fontSize: 10,
          fontFamily: "var(--font-mono), monospace",
          formatter: (v: number) => fmtMs(v),
        },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: rows.map((r) => r.span.spanId),
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: "#a9b6c4",
          fontSize: 9,
          fontFamily: "var(--font-mono), monospace",
          width: 170,
          overflow: "truncate",
          formatter: (id: string) => {
            const r = rows.find((x) => x.span.spanId === id);
            if (!r) return "";
            const indent = "  ".repeat(Math.min(r.depth, 5));
            return `${indent}${r.span.spanName.slice(0, 30)}`;
          },
        },
      },
      tooltip: {
        ...TOOLTIP,
        // The waterfall lives inside the trace ribbon's expanded panel, which is
        // `overflow-hidden` for its height tween. A tooltip near the top rows
        // would be clipped by that; rendering it into document.body escapes the
        // clip entirely.
        appendToBody: true,
        formatter: (p: never) => {
          const params = p as unknown as { dataIndex: number };
          const r = rows[params.dataIndex];
          if (!r) return "";
          const s = r.span;
          return [
            `<b>${s.spanName}</b>`,
            `category  ${s.spanCategory}`,
            `duration  ${fmtMs(s.latencyMs)}`,
            `offset    ${fmtMs(r.start)}`,
            `depth     ${r.depth}`,
            s.modelName ? `model     ${s.modelName}` : "",
            s.toolStatus ? `status    ${s.toolStatus}` : "",
            s.toolStatusDescription
              ? `detail    ${s.toolStatusDescription.slice(0, 120)}`
              : "",
          ]
            .filter(Boolean)
            .join("<br/>");
        },
      },
      series: [
        {
          type: "custom",
          renderItem: (params: never, api: never) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const a = api as any;
            const idx = a.value(0) as number;
            const r = rows[idx];
            if (!r) return null;
            const startPt = a.coord([r.start, idx]);
            const endPt = a.coord([r.end, idx]);
            const h = Math.max(4, (a.size([0, 1]) as number[])[1] * 0.58);
            const w = Math.max(1.5, endPt[0] - startPt[0]);
            const color = r.span.isToolError
              ? "#ff5a5f"
              : (CAT_COLOR[r.span.spanCategory] ?? "#48545f");
            return {
              type: "rect",
              shape: { x: startPt[0], y: startPt[1] - h / 2, width: w, height: h, r: 1 },
              style: {
                fill: color,
                opacity: r.span.isToolError ? 0.95 : 0.8,
                stroke: r.span.isToolError ? "#ff5a5f" : "transparent",
                lineWidth: r.span.isToolError ? 1 : 0,
              },
            };
          },
          encode: { x: [1, 2], y: 0 },
          data: rows.map((r, i) => [i, r.start, r.end]),
        },
      ],
    };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="grid h-[200px] place-items-center border border-dashed border-line-faint">
        <span className="label-micro">Select a trace to inspect its span tree</span>
      </div>
    );
  }

  // Critical path: the deepest chain of spans by cumulative self time, which is
  // what actually determines wall-clock duration.
  const total = Math.max(...rows.map((r) => r.end));
  const contributors = Object.entries(
    rows.reduce<Record<string, number>>((acc, r) => {
      if (["Agent", "Agent Wrapper", "Request Envelope"].includes(r.span.spanCategory)) return acc;
      acc[r.span.spanCategory] = (acc[r.span.spanCategory] ?? 0) + (r.span.latencyMs ?? 0);
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div>
      <Chart option={option} height={Math.max(180, rows.length * 17 + 40)} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-faint pt-2 font-mono text-[10px]">
        <span className="text-ink-faint">
          wall clock <span className="text-ink-hi">{fmtMs(total)}</span>
        </span>
        {contributors.map(([cat, ms]) => (
          <span key={cat} className="flex items-center gap-1 text-ink-faint">
            <span
              className="h-1.5 w-1.5 shrink-0"
              style={{ background: CAT_COLOR[cat] ?? "#48545f" }}
            />
            {cat} <span className="text-ink">{fmtMs(ms)}</span>
          </span>
        ))}
      </div>
      <p className="mt-1 font-mono text-[9px] leading-relaxed text-ink-faint">
        Bar sums exceed wall clock where spans ran concurrently — that overlap is the point, since
        it shows which work was parallelised and which serialised.
        {excluded > 0 && (
          <>
            {" "}
            {excluded} span{excluded === 1 ? "" : "s"} omitted: the emitted start timestamp was
            after the end timestamp, so no duration could be derived.
          </>
        )}
      </p>
    </div>
  );
}

export { CAT_COLOR };
