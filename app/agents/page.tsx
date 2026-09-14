"use client";

import { Suspense, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAgent } from "@/lib/hooks";
import { useShell } from "@/components/console/console-shell";
import { Chart, Panel } from "@/components/ui/chart";
import { KpiCard } from "@/components/fleet/kpi-card";
import { MetricInfo } from "@/components/fleet/metric-info";
import { AgentIdentityBanner, type AgentIdentity } from "@/components/fleet/agent-identity";
import { TraceWaterfall, CAT_COLOR, type Span } from "@/components/fleet/trace-waterfall";
import { AXIS, TOOLTIP, fmtNum, fmtMs, fmtPct, axisLabel } from "@/lib/echarts";
import {
  explainRequests,
  explainCost,
  explainErrorRates,
  explainTurnsPerThread,
} from "@/lib/fleet-sql";
import { TOKEN_COLORS } from "@/lib/constants";

type TraceRow = {
  traceId: string;
  ts: string | null;
  durationMs: number;
  userName: string | null;
  planningSteps: number;
  isRequestError: boolean;
  toolErrorCount: number;
  totalTokens: number;
};

/** Short relative time. Trace lists are scanned, and "2h ago" scans faster than a timestamp. */
function relTs(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * One trace, as an expandable ribbon. Visual vocabulary matches the feedback
 * ribbon (3px glowing status spine, hairline separator, chevron that rotates).
 *
 * State model differs from that one though, deliberately. There, `open` is local
 * useState and several rows can be open at once. Here, expanding IS selecting and
 * it drives a fetch, so `open` is passed down from the URL param. See the call
 * site for why.
 *
 * Not extracted into a shared component with the feedback ribbon: the two differ
 * in state model, in columns, and the feedback one derives its hue from
 * isPositive. A slot-based abstraction for two divergent callers would cost more
 * than it saves. Worth revisiting if a third appears.
 */
function TraceRibbon({
  t,
  open,
  onToggle,
  spans,
}: {
  t: TraceRow;
  open: boolean;
  onToggle: () => void;
  spans: Span[];
}) {
  // Request error outranks tool error: the turn failed outright, so the fact that
  // a tool also failed inside it is the lesser finding.
  const hue = t.isRequestError
    ? "var(--color-st-critical)"
    : t.toolErrorCount > 0
      ? "var(--color-st-degraded)"
      : "var(--color-st-nominal)";
  const glyph = t.isRequestError ? "■" : t.toolErrorCount > 0 ? "▲" : "·";
  const glyphTitle = t.isRequestError
    ? "Request failed: the whole turn errored"
    : t.toolErrorCount > 0
      ? `Turn returned, but ${t.toolErrorCount} tool call${t.toolErrorCount === 1 ? "" : "s"} failed inside it`
      : "No errors";

  return (
    <li className="border-b border-line-faint last:border-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-raised/40"
      >
        <span
          className="h-7 w-[3px] shrink-0"
          style={{ background: hue, boxShadow: `0 0 8px -1px ${hue}` }}
        />

        <span
          className="w-4 shrink-0 text-center font-mono text-[11px]"
          style={{ color: hue }}
          title={glyphTitle}
        >
          {glyph}
        </span>

        {/* Latency leads, because the list is ordered by it. */}
        <span className="w-16 shrink-0 font-mono text-[12px] text-ink-hi">
          {fmtMs(t.durationMs)}
        </span>

        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-lo"
          title={t.traceId}
        >
          {t.traceId.slice(0, 16)}…
        </span>

        <span className="hidden w-24 shrink-0 truncate font-mono text-[11px] text-ink sm:block">
          {t.userName ?? "—"}
        </span>

        <span className="hidden w-20 shrink-0 font-mono text-[10px] text-ink-lo md:block">
          {relTs(t.ts)}
        </span>

        <span
          className="w-16 shrink-0 text-right font-mono text-[10px] text-ink-faint"
          title={`${t.totalTokens.toLocaleString()} tokens · ${t.planningSteps} planning steps`}
        >
          {t.totalTokens > 0 ? fmtNum(t.totalTokens) : "—"}
        </span>

        <span
          className={`shrink-0 font-mono text-[10px] text-ink-faint transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ›
        </span>
      </button>

      {open && (
        // animate-fadeup rather than a motion/react height tween: it is the app's
        // declared entrance and, being CSS, respects prefers-reduced-motion via the
        // global guard. A height tween is also wrong here because the waterfall
        // arrives asynchronously, so its final height is unknown at open time.
        <div className="animate-fadeup border-t border-line-faint bg-inset/50 px-3 py-2.5">
          <TraceWaterfall spans={spans} />
        </div>
      )}
    </li>
  );
}

function AgentsInner() {
  const { window: win } = useShell();
  const router = useRouter();
  const params = useSearchParams();
  const agent = params.get("agent");
  const trace = params.get("trace");

  const { data, error } = useAgent(win, agent, trace);

  const agents: Array<{ agentFqn: string; displayName: string; turnsTotal: number }> =
    data?.agents ?? [];
  const trend = data?.trend ?? [];
  const tokens = data?.tokens ?? [];
  const resources = data?.resources ?? [];
  const cohorts = data?.latencyCohorts ?? [];
  const slowTraces = data?.slowTraces ?? [];
  const usersRoles = data?.usersRoles ?? [];
  const feedback = data?.feedback ?? [];
  const spans: Span[] = data?.spans ?? [];
  const k = data?.kpis;
  const cost = data?.cost;
  const identity: AgentIdentity | null = data?.identity ?? null;

  // Cost split for the Agent Cost subline, largest share first. Same treatment as
  // the home page: shares of SPEND, not of tokens.
  const costSplit = useMemo(() => {
    if (!cost?.metered) return undefined;
    return (
      [
        { k: "cache write", v: cost.pctCacheWrite },
        { k: "cache read", v: cost.pctCacheRead },
        { k: "output", v: cost.pctOutput },
        { k: "input", v: cost.pctInput },
      ]
        .filter((p): p is { k: string; v: number } => typeof p.v === "number")
        .sort((a, b) => b.v - a.v)
        .map((p) => `${p.k} ${Math.round(p.v)}%`)
        .join(" · ") || undefined
    );
  }, [cost]);

  const setAgent = (fqn: string) => {
    const p = new URLSearchParams();
    p.set("agent", fqn);
    router.push(`/agents?${p.toString()}`);
  };
  const setTrace = (t: string) => {
    const p = new URLSearchParams();
    if (agent) p.set("agent", agent);
    p.set("trace", t);
    router.push(`/agents?${p.toString()}`);
  };
  /** Collapse the open ribbon. Drops `trace` so the span fetch is skipped. */
  const clearTrace = () => {
    const p = new URLSearchParams();
    if (agent) p.set("agent", agent);
    router.push(`/agents?${p.toString()}`);
  };

  /** Requests + error overlay + latency on a second axis. */
  const trendOption = useMemo(
    () => ({
      grid: { left: 40, right: 46, top: 20, bottom: 22 },
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: {
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: {
        type: "category",
        data: trend.map((t: { ts: string }) => axisLabel(t.ts, win)),
        ...AXIS,
      },
      yAxis: [
        { type: "value", ...AXIS, minInterval: 1 },
        {
          type: "value",
          ...AXIS,
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtMs(v) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "Requests",
          type: "bar",
          data: trend.map((t: { requests: number }) => t.requests),
          itemStyle: { color: "#2c3a48" },
          barMaxWidth: 20,
        },
        {
          name: "Request errors",
          type: "bar",
          stack: "e",
          data: trend.map((t: { requestErrors: number }) => t.requestErrors),
          itemStyle: { color: "#ff5a5f" },
          barMaxWidth: 20,
        },
        {
          name: "Tool errors",
          type: "bar",
          stack: "e",
          data: trend.map((t: { toolErrors: number }) => t.toolErrors),
          itemStyle: { color: "#ffc53d" },
          barMaxWidth: 20,
        },
        {
          name: "p95",
          type: "line",
          yAxisIndex: 1,
          data: trend.map((t: { p95Ms: number }) => t.p95Ms),
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { width: 1.5, color: "#7ad7f0" },
          itemStyle: { color: "#7ad7f0" },
        },
      ],
    }),
    [trend, win],
  );

  /**
   * Token breakout.
   *
   * Only the additive decomposition is stacked. Verified on every LLM span in
   * this account: total = input + output, and cache_read + cache_write are
   * SUBSETS of input. Stacking all five reported categories flat would sum to
   * 71.7M against a real total of 35.3M, so input is split into its cache and
   * fresh components and plan tokens ride as a separate line rather than a
   * stack segment, because plan is not additive into the total.
   */
  const tokenOption = useMemo(() => {
    const stackKeys: Array<[string, string]> = [
      ["Cache Read", "cacheReadInput"],
      ["Cache Write", "cacheWriteInput"],
      ["Fresh Input", "freshInput"],
      ["Output", "output"],
    ];
    return {
      grid: { left: 48, right: 44, top: 20, bottom: 22 },
      tooltip: {
        ...TOOLTIP,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v: number) => fmtNum(v),
      },
      legend: {
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: {
        type: "category",
        data: tokens.map((t: { ts: string }) => axisLabel(t.ts, win)),
        ...AXIS,
      },
      yAxis: [
        {
          type: "value",
          ...AXIS,
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtNum(v) },
        },
        {
          type: "value",
          ...AXIS,
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtNum(v) },
          splitLine: { show: false },
        },
      ],
      series: [
        ...stackKeys.map(([label, key]) => ({
          name: label,
          type: "bar" as const,
          stack: "tok",
          barMaxWidth: 22,
          itemStyle: { color: TOKEN_COLORS[label] },
          data: tokens.map((t: Record<string, number>) => t[key] ?? 0),
        })),
        {
          name: "Plan (not additive)",
          type: "line" as const,
          yAxisIndex: 1,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { width: 1.5, color: "#d98c6a", type: "dashed" as const },
          itemStyle: { color: "#d98c6a" },
          data: tokens.map((t: { plan: number }) => t.plan ?? 0),
        },
      ],
    };
  }, [tokens, win]);

  /**
   * Latency decomposition by cohort. Grouped bars comparing the p95 cohort
   * against the typical cohort, per span category - NOT a stacked p95, because
   * percentiles do not sum and a stacked-p95 total is a duration no request ever
   * actually experienced.
   */
  const cohortOption = useMemo(() => {
    const cats = Array.from(
      new Set(cohorts.map((c: { spanCategory: string }) => c.spanCategory)),
    );
    const pick = (cohort: string, cat: string) =>
      cohorts.find(
        (c: { cohort: string; spanCategory: string }) =>
          c.cohort === cohort && c.spanCategory === cat,
      )?.meanMsPerTrace ?? 0;
    // order by tail contribution, descending
    cats.sort((a, b) => pick("TAIL_P95", String(b)) - pick("TAIL_P95", String(a)));
    return {
      grid: { left: 150, right: 40, top: 20, bottom: 22 },
      tooltip: {
        ...TOOLTIP,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        valueFormatter: (v: number) => fmtMs(v),
      },
      legend: {
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: {
        type: "value",
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtMs(v) },
      },
      yAxis: { type: "category", data: cats, ...AXIS },
      series: [
        {
          name: "Slowest 5% of turns",
          type: "bar",
          data: cats.map((c) => pick("TAIL_P95", String(c))),
          itemStyle: { color: "#d98c6a" },
          barMaxWidth: 11,
        },
        {
          name: "Typical turns (p50)",
          type: "bar",
          data: cats.map((c) => pick("TYPICAL_P50", String(c))),
          itemStyle: { color: "#4fb8c9" },
          barMaxWidth: 11,
        },
      ],
    };
  }, [cohorts]);

  /**
   * Feedback as two distinct lines rather than a stacked bar, so positive and
   * negative can be read as independent trends instead of a composition.
   *
   * showSymbol/symbolSize are NOT cosmetic here. An ECharts line with a single
   * data point draws no visible line at all, and feedback in this account is very
   * sparse - three of the five agents that have any feedback have it on exactly
   * ONE day. Without explicit symbols those agents render a completely blank
   * panel that looks broken rather than sparse.
   *
   * Missing buckets stay null and connectNulls is off: a day with no feedback is
   * not a day with zero-rated feedback, and joining across the gap would invent a
   * trend line through days nobody rated anything.
   */
  const feedbackOption = useMemo(
    () => ({
      grid: { left: 34, right: 12, top: 18, bottom: 22 },
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: {
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: {
        type: "category",
        data: feedback.map((f: { ts: string }) => axisLabel(f.ts, win)),
        ...AXIS,
      },
      yAxis: { type: "value", ...AXIS, minInterval: 1 },
      series: [
        {
          name: "Positive",
          type: "line",
          data: feedback.map((f: { positive: number }) => f.positive),
          itemStyle: { color: "#2fd8a6" },
          lineStyle: { color: "#2fd8a6", width: 1.5 },
          showSymbol: true,
          symbolSize: 6,
          connectNulls: false,
        },
        {
          name: "Negative",
          type: "line",
          data: feedback.map((f: { negative: number }) => f.negative),
          itemStyle: { color: "#ff5a5f" },
          lineStyle: { color: "#ff5a5f", width: 1.5 },
          showSymbol: true,
          symbolSize: 6,
          connectNulls: false,
        },
      ],
    }),
    [feedback, win],
  );

  /**
   * Positive/negative totals for the window.
   *
   * Summed from the SAME buckets the lines are drawn from, not fetched separately.
   * The buckets partition the window, so the sum is exact, and one source means
   * the donut can never contradict the chart beside it - which a second query
   * with its own predicates eventually would.
   */
  const feedbackTotals = useMemo(() => {
    let positive = 0;
    let negative = 0;
    for (const f of feedback as Array<{ positive: number; negative: number }>) {
      positive += f.positive;
      negative += f.negative;
    }
    return { positive, negative, total: positive + negative };
  }, [feedback]);

  const feedbackDonutOption = useMemo(
    () => ({
      tooltip: { ...TOOLTIP, trigger: "item" },
      // No `grid` key: pie/donut series are not laid out on a cartesian grid and
      // ECharts ignores it.
      series: [
        {
          type: "pie",
          radius: ["58%", "80%"],
          center: ["50%", "52%"],
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderColor: "#0e141c", borderWidth: 2 },
          data: [
            { name: "Positive", value: feedbackTotals.positive, itemStyle: { color: "#2fd8a6" } },
            { name: "Negative", value: feedbackTotals.negative, itemStyle: { color: "#ff5a5f" } },
          ].filter((d) => d.value > 0),
        },
      ],
    }),
    [feedbackTotals],
  );

  if (error) {
    return (
      <div className="panel border-st-critical/40 p-4">
        <div className="label-micro mb-1 text-st-critical">Agent query failed</div>
        <pre className="overflow-x-auto font-mono text-[11px] text-ink">{String(error)}</pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- agent selector ---------- */}
      <div className="panel flex flex-wrap items-center gap-1.5 px-3 py-2">
        <span className="label-micro mr-1">Agent</span>
        {agents.map((a) => (
          <button
            key={a.agentFqn}
            onClick={() => setAgent(a.agentFqn)}
            title={a.agentFqn}
            className={`rounded-chip border px-2 py-[3px] font-mono text-[11px] transition-colors ${
              agent === a.agentFqn
                ? "border-line-strong bg-raised text-ink-hi"
                : "border-line text-ink-lo hover:border-line-strong hover:text-ink"
            }`}
          >
            {a.displayName ?? a.agentFqn.split(".").pop()}
            <span className="ml-1.5 text-ink-faint">{a.turnsTotal}</span>
          </button>
        ))}
      </div>

      {!agent ? (
        <div className="panel grid h-[240px] place-items-center">
          <div className="text-center">
            <div className="label-micro">Select an agent above</div>
            <p className="mt-2 max-w-[46ch] font-mono text-[10px] leading-relaxed text-ink-faint">
              Or press ⌘K and search by name. Clicking a tile on the fleet page opens it here
              directly.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* ---------- identity ----------
              Keyed on the FQN so React remounts on agent change and the
              animate-fadeup entrance replays. Without the key the text swaps with
              no transition. */}
          <AgentIdentityBanner key={agent} identity={identity} agentFqn={agent} />

          {/* ---------- KPI row ----------
              Same four-tile treatment as the fleet page, scoped to this agent.
              Turns per Thread sits second because it is the engagement metric the
              other three are read against. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Agent Requests"
              value={k ? k.requests : null}
              detail={`p95 ${fmtMs(k?.p95Ms)}`}
              description="The number of individual requests, or turns, made to this agent in the window. One turn is a single prompt-and-response cycle, not a whole conversation."
              sql={explainRequests(win, data?.config?.excludeEvalRuns ?? true, agent)}
              hint="Counted as root AgentV2RequestResponseInfo spans. p95 is computed over successful turns only."
            />

            <KpiCard
              label="Turns per Thread"
              value={k?.turnsPerThread ?? null}
              format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
              subvalue={
                k
                  ? `${k.threads} thread${k.threads === 1 ? "" : "s"} · longest ${k.maxTurnsInThread}`
                  : undefined
              }
              // Only shown when non-zero. A silently smaller denominator is the
              // whole trap this metric has, so when turns are excluded, say so.
              detail={
                k && k.threadlessTurns > 0
                  ? `${k.threadlessTurns} turn${k.threadlessTurns === 1 ? "" : "s"} had no thread id`
                  : undefined
              }
              description="How many turns the average conversation runs to. A thread is one session, so this is the depth of a typical back-and-forth with this agent rather than a count of one-shot questions."
              sql={explainTurnsPerThread(win, data?.config?.excludeEvalRuns ?? true, agent)}
              hint="Divides turns that CARRY a thread id by the number of distinct threads. thread_id is not always populated, and dividing all turns by distinct threads would credit threadless turns to threads that never held them."
            />

            <KpiCard
              label="Agent Cost"
              value={cost?.usd ?? null}
              format={{ style: "currency", currency: "USD", maximumFractionDigits: 2 }}
              subvalue={costSplit ?? "awaiting metering (up to 1h)"}
              subcolor={costSplit ? "var(--color-ink-lo)" : "var(--color-ink-faint)"}
              detail={
                cost?.metered
                  ? `${(cost.credits ?? 0).toFixed(1)} AI credits · ${cost.pricedRequests} priced`
                  : undefined
              }
              description="The estimated cost of this agent's requests in the window, priced from the credits Snowflake metered for each request, then split by where that spend went."
              sql={explainCost(win, data?.config?.excludeEvalRuns ?? true, cost?.usdPerAiCredit ?? 2, agent)}
              infoAlign="right"
              hint="Token credits only. Excludes warehouse compute for SQL this agent ran, and Cortex Search serving. Percentages are shares of SPEND, not of tokens. Metering lags up to 1 hour."
            />

            {/* Hand-rolled because it renders two rates side by side over a shared
                denominator, which a single-value KpiCard cannot express. */}
            <div className="panel relative flex flex-col gap-1 px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="label-micro">Error Rate</span>
                <MetricInfo
                  label="Error Rate"
                  align="right"
                  description="The share of this agent's requests that failed, split by where the failure happened: Request is the whole turn failing, Tool is an individual step failing inside a turn that still returned."
                  sql={explainErrorRates(win, data?.config?.excludeEvalRuns ?? true, agent)}
                  hint="Reported separately, never blended. A turn can survive a failed tool, so the two rates share a denominator but are not additive - the same turn can appear in both."
                />
              </div>
              <div className="flex items-end gap-4">
                <div>
                  <div className="font-mono text-[26px] leading-none text-ink-hi" data-metric>
                    {k?.requestErrorRate === null || k?.requestErrorRate === undefined
                      ? "—"
                      : `${k.requestErrorRate.toFixed(1)}%`}
                  </div>
                  <div className="label-micro mt-1">Request</div>
                </div>
                <div className="h-8 w-px bg-line" />
                <div>
                  <div className="font-mono text-[18px] leading-none text-ink" data-metric>
                    {k?.toolErrorRate === null || k?.toolErrorRate === undefined
                      ? "—"
                      : `${k.toolErrorRate.toFixed(1)}%`}
                  </div>
                  <div className="label-micro mt-1">Tool</div>
                </div>
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
                {k?.requestErrors ?? 0} req · {k?.toolErrorTurns ?? 0} tool ·{" "}
                {k?.degradedSuccess ?? 0} degraded
              </div>
            </div>
          </div>

          {/* ---------- requests + latency ---------- */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel
              title={`Requests, errors & latency · ${win.toUpperCase()}`}
              hint="Bars are request counts with errors stacked separately. The line is p95 turn duration on the right axis, computed over successful turns only."
            >
              <Chart option={trendOption} height={210} empty={trend.length === 0} />
            </Panel>

            <Panel
              title="Token usage by category"
              hint="Stacked segments are the additive decomposition and reconcile exactly to total tokens: cache-read + cache-write + fresh input = input, and input + output = total. Plan tokens are reported separately on the right axis because they are not additive into the total — they exceed output on most spans."
            >
              <Chart option={tokenOption} height={210} empty={tokens.length === 0} />
              <p className="mt-1 font-mono text-[9px] leading-relaxed text-ink-faint">
                Cache-read tokens bill at a discount and cache-write at a premium, so the split is a
                cost view rather than a volume view. A tall cache-read segment is good news.
              </p>
            </Panel>
          </div>

          {/* ---------- latency decomposition ---------- */}
          <Panel
            title="What makes the slow turns slow"
            hint="Mean self-time per span category, comparing the slowest 5% of turns against typical turns. Cohorts are selected by total turn duration, because percentiles cannot be summed across span categories."
          >
            <Chart
              option={cohortOption}
              height={Math.max(170, cohorts.length * 14 + 60)}
              empty={cohorts.length === 0}
            />
          </Panel>

          {/* ---------- resources ---------- */}
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
            <Panel
              title="Resources used"
              hint="Frequency, p95 latency and error count for every semantic view, search service, skill and tool this agent invoked."
            >
              {resources.length === 0 ? (
                <div className="label-micro py-6 text-center">No tool spans in window</div>
              ) : (
                <div className="max-h-[300px] overflow-y-auto">
                  <table className="w-full text-left font-mono text-[11px]">
                    <thead className="sticky top-0 bg-panel">
                      <tr className="border-b border-line text-ink-faint">
                        <th className="py-1 pr-2 font-400">Kind</th>
                        <th className="py-1 pr-2 font-400">Name</th>
                        <th className="py-1 pr-2 text-right font-400">Calls</th>
                        <th className="py-1 pr-2 text-right font-400">p95</th>
                        <th className="py-1 text-right font-400">Err</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resources.map(
                        (
                          r: {
                            kind: string;
                            name: string;
                            n: number;
                            p95Ms: number;
                            errors: number;
                          },
                          i: number,
                        ) => (
                          <tr
                            key={`${r.kind}-${r.name}-${i}`}
                            className="border-b border-line-faint last:border-0"
                          >
                            <td className="py-1.5 pr-2">
                              <span
                                className="inline-block h-1.5 w-1.5 shrink-0 align-middle"
                                style={{
                                  background:
                                    CAT_COLOR[
                                      r.kind === "Semantic View"
                                        ? "Semantic Context"
                                        : r.kind === "Cortex Search"
                                          ? "Cortex Search"
                                          : r.kind === "Skill"
                                            ? "Skill"
                                            : "Other"
                                    ] ?? "#48545f",
                                }}
                              />
                              <span className="ml-1.5 text-ink-lo">{r.kind}</span>
                            </td>
                            <td
                              className="max-w-[220px] truncate py-1.5 pr-2 text-ink"
                              title={r.name}
                            >
                              {r.name}
                            </td>
                            <td className="py-1.5 pr-2 text-right text-ink-hi">{r.n}</td>
                            <td className="py-1.5 pr-2 text-right text-ink-lo">
                              {fmtMs(r.p95Ms)}
                            </td>
                            <td
                              className="py-1.5 text-right"
                              style={{ color: r.errors > 0 ? "#ff5a5f" : "var(--color-ink-faint)" }}
                            >
                              {r.errors}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <div className="grid gap-3">
              <Panel
                title="Users & roles"
                hint="Turn counts by user and primary session role."
              >
                {usersRoles.length === 0 ? (
                  <div className="label-micro py-6 text-center">No data in window</div>
                ) : (
                  <table className="w-full text-left font-mono text-[11px]">
                    <thead>
                      <tr className="border-b border-line text-ink-faint">
                        <th className="py-1 pr-2 font-400">User</th>
                        <th className="py-1 pr-2 font-400">Role</th>
                        <th className="py-1 pr-2 text-right font-400">Turns</th>
                        <th className="py-1 text-right font-400">Err</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usersRoles.map(
                        (
                          u: {
                            userName: string;
                            roleName: string;
                            requests: number;
                            errors: number;
                          },
                          i: number,
                        ) => (
                          <tr
                            key={`${u.userName}-${u.roleName}-${i}`}
                            className="border-b border-line-faint last:border-0"
                          >
                            <td className="py-1.5 pr-2 text-ink">{u.userName}</td>
                            <td className="py-1.5 pr-2 text-ink-lo">{u.roleName}</td>
                            <td className="py-1.5 pr-2 text-right text-ink-hi">{u.requests}</td>
                            <td
                              className="py-1.5 text-right"
                              style={{
                                color: u.errors > 0 ? "#ff5a5f" : "var(--color-ink-faint)",
                              }}
                            >
                              {u.errors}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                )}
              </Panel>

              <Panel
                title="Feedback over time"
                hint="Explicit thumbs up/down submitted against this agent's responses. Positive and negative are separate lines, not a stack, so each can be read as its own trend. Gaps are days with no feedback at all, not days rated zero."
                right={
                  <span className="font-mono text-[10px] text-ink-faint">
                    {feedbackTotals.total} total
                  </span>
                }
              >
                {feedbackTotals.total === 0 ? (
                  // 5 of 10 agents have never received feedback. An explicit
                  // statement beats two empty axes and an empty ring.
                  <div className="grid h-[140px] place-items-center border border-dashed border-line-faint">
                    <span className="label-micro">No feedback submitted in this window</span>
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-[1fr_128px]">
                    <Chart option={feedbackOption} height={140} />
                    {/* Donut + centred total. The number lives in the hole as a
                        DOM overlay rather than an ECharts label so it inherits
                        the app's font stack and tabular figures. */}
                    <div className="relative h-[140px]">
                      <Chart option={feedbackDonutOption} height={140} />
                      <div className="pointer-events-none absolute inset-0 grid place-items-center">
                        <div className="text-center">
                          <div
                            className="font-mono text-[18px] leading-none text-ink-hi"
                            data-metric
                          >
                            {feedbackTotals.total}
                          </div>
                          <div className="label-micro mt-1 text-[9px]">rated</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Panel>
            </div>
          </div>

          {/* ---------- trace waterfall ---------- */}
          <Panel
            title="Trace inspector"
            hint="One row per turn, slowest first. Expanding a row loads its span tree, positioned at true start offsets with depth from parent_span_id. Overlapping bars are genuinely concurrent spans."
            pad={false}
            right={
              <span className="font-mono text-[10px] text-ink-faint">
                {slowTraces.length} slowest turns
              </span>
            }
          >
            {slowTraces.length === 0 ? (
              <div className="grid h-[160px] place-items-center">
                <span className="label-micro">No turns in this window</span>
              </div>
            ) : (
              <ul className="flex flex-col">
                {slowTraces.map((t: TraceRow) => (
                  <TraceRibbon
                    key={t.traceId}
                    t={t}
                    // Open state is DERIVED FROM THE URL, not local component
                    // state. Expanding a row is what triggers the span fetch
                    // (useAgent refetches on the `trace` param), so local state
                    // would let a row look open while the waterfall below showed
                    // a different trace. This also makes exactly one row open at
                    // a time, and makes the open row linkable and reload-safe.
                    open={trace === t.traceId}
                    onToggle={() => (trace === t.traceId ? clearTrace() : setTrace(t.traceId))}
                    spans={spans}
                  />
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<div className="label-micro p-4">Loading…</div>}>
      <AgentsInner />
    </Suspense>
  );
}
