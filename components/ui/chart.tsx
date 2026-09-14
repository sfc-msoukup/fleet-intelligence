"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { EChartsOption } from "echarts";
import { echarts } from "@/lib/echarts";

// ECharts touches the DOM on init, so it must be client-only. A fixed-height
// skeleton avoids a layout shift when it hydrates.
const EChartsReactCore = dynamic(() => import("echarts-for-react/lib/core"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-inset/60" />,
});

/**
 * ECharts option.
 *
 * Typed permissively on purpose. ECharts' generated option types are
 * discriminated unions over `type` (`yAxis` narrows to CategoryAxis vs ValueAxis,
 * `tooltip` to TooltipOption, and `valueFormatter` is declared as
 * `(value: OptionDataValue[] | OptionDataValue, dataIndex: number) => string`).
 * Composing options by spreading shared constants - which is what keeps every
 * chart in this app visually consistent - defeats that narrowing, so the strict
 * type rejects correct configurations. Widening here keeps the shared-constant
 * pattern instead of duplicating axis config into every chart to satisfy the
 * checker.
 */
export type ChartOption = EChartsOption | Record<string, unknown>;

export function Chart({
  option,
  height = 220,
  onEvents,
  empty,
}: {
  option: ChartOption;
  height?: number;
  onEvents?: Record<string, (params: unknown) => void>;
  empty?: boolean;
}) {
  if (empty) {
    return (
      <div
        className="grid place-items-center border border-dashed border-line-faint bg-inset/40"
        style={{ height }}
      >
        <span className="label-micro">No data in window</span>
      </div>
    );
  }
  return (
    <div style={{ height }}>
      <EChartsReactCore
        echarts={echarts}
        option={option}
        style={{ height: "100%", width: "100%" }}
        notMerge
        lazyUpdate
        onEvents={onEvents}
      />
    </div>
  );
}

/** Panel: tonal step + hairline + bevel. No drop shadow for elevation. */
export function Panel({
  title,
  hint,
  right,
  children,
  className = "",
  pad = true,
}: {
  title?: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`panel flex min-w-0 flex-col ${className}`}>
      {(title || right) && (
        <header className="flex shrink-0 items-center gap-2 border-b border-line-faint px-3 py-2">
          {title && <h2 className="label-micro">{title}</h2>}
          {hint && (
            <span
              className="cursor-help font-mono text-[10px] text-ink-faint"
              title={hint}
            >
              ⓘ
            </span>
          )}
          {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={`min-w-0 flex-1 ${pad ? "p-3" : ""}`}>{children}</div>
    </section>
  );
}

/** Provenance badge. Where a limit came from is part of the number's meaning. */
export function SourceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  const map: Record<string, { label: string; title: string }> = {
    account_view: {
      label: "ACCOUNT",
      title: "Read live from SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_RATE_LIMIT_POLICIES",
    },
    public_docs: { label: "DOCS", title: "Documented Snowflake limit" },
    internal_verified: {
      label: "INTERNAL",
      title: "Verified from internal Snowflake guidance, not currently in public docs",
    },
  };
  const m = map[source] ?? { label: source.toUpperCase(), title: source };
  return (
    <span
      title={m.title}
      className="rounded-chip border border-line px-1 py-[1px] font-mono text-[9px] tracking-wide text-ink-faint"
    >
      {m.label}
    </span>
  );
}

/** Status pill: colour PLUS glyph PLUS word, never colour alone. */
export function StatusPill({ state }: { state: string }) {
  const map: Record<string, { c: string; g: string }> = {
    NOMINAL: { c: "text-st-nominal", g: "●" },
    IDLE: { c: "text-st-idle", g: "◐" },
    CRITICAL: { c: "text-st-critical", g: "■" },
    OFF: { c: "text-st-off", g: "○" },
  };
  const m = map[state] ?? map.OFF;
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${m.c}`}>
      <span aria-hidden>{m.g}</span>
      <span>{state}</span>
    </span>
  );
}
