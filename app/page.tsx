"use client";

import { useMemo, useState } from "react";
import { useFleet, useLimits } from "@/lib/hooks";
import { useShell } from "@/components/console/console-shell";
import { KpiCard } from "@/components/fleet/kpi-card";
import { HexFleet, type HexAgent } from "@/components/fleet/hex-fleet";
import { Chart, Panel, StatusPill, SourceBadge } from "@/components/ui/chart";
import { SaturationGauge, SaturationReading, BarList } from "@/components/fleet/saturation";
import { AXIS, TOOLTIP, fmtMs, fmtPct, fmtNum, axisLabel } from "@/lib/echarts";
import { explainRequests, explainActiveAgents, explainCost, explainErrorRates } from "@/lib/fleet-sql";
import { HexConfigPopover } from "@/components/fleet/hex-config";
import { MetricInfo } from "@/components/fleet/metric-info";

type ModelRow = {
  model: string;
  tpmLimit: number;
  rpmLimit: number;
  source: string | null;
  peakTpm: number;
  peakRpm: number;
  p50Tpm: number;
  p99Tpm: number;
  totalTokens: number;
  activeMinutes: number;
  pctTpm: number;
  pctRpm: number;
};

type CostBlock = {
  metered: boolean;
  pricedRequests: number;
  credits: number | null;
  usd: number | null;
  usdPerAiCredit: number;
  pctInput: number | null;
  pctOutput: number | null;
  pctCacheRead: number | null;
  pctCacheWrite: number | null;
};

// Column count per gauge total. Every value is a clean divisor of its key, so a
// wrapped row is never left holding an orphan card. Spelled out as literal
// class strings because Tailwind only generates classes it can see in source -
// a computed `grid-cols-${n}` would emit nothing.
const GAUGE_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
};

export default function FleetHome() {
  const { window: win } = useShell();
  const { data, isPending, error } = useFleet(win);
  // Second poll rather than one merged endpoint: 13 statements in a single
  // Promise.all against an XSMALL interactive warehouse with a 5s statement
  // timeout is real queue risk. Both hooks share REFRESH_MS and run in
  // parallel, so page latency is max() of the two, not the sum.
  const { data: lim, error: limError } = useLimits(win);
  const [showConfig, setShowConfig] = useState(false);

  const k = data?.kpis;
  const hex: HexAgent[] = data?.hex ?? [];
  const trend: Array<{ ts: string; requests: number; requestErrors: number; toolErrors: number }> =
    data?.trend ?? [];

  // Hex state tallies for the Agent Fleet legend ONLY.
  //
  // These must not appear on a windowed KPI card. Hex state comes from
  // FLEET_CONFIG thresholds measured against now, and qHexFleet takes no window
  // argument, so these counts do not move with the window selector. Sitting them
  // under a windowed figure like Active Agents implied they were a breakdown of
  // it, which they are not - at 60m the tile can read 0 active while the subline
  // still claims several nominal.
  const counts = useMemo(() => {
    const c = { NOMINAL: 0, IDLE: 0, CRITICAL: 0, OFF: 0 } as Record<string, number>;
    for (const a of hex) c[a.state] = (c[a.state] ?? 0) + 1;
    return c;
  }, [hex]);

  const cost: CostBlock | undefined = data?.cost;

  // Cost split for the Agent Cost subline. Ordered by share DESCENDING and built
  // from whatever is present, rather than a fixed input/output/cache order: the
  // point of the subline is to show which bucket dominates spend, and that varies
  // by window. `input` legitimately renders as 0% in most windows here - fresh
  // input is ~2k tokens against 36M cached - which is information, not a bug.
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

  /* ---------- ceilings, moved here from /limits ---------- */

  const models: ModelRow[] = lim?.modelSaturation ?? [];
  const agentApi = lim?.agentApi;
  const searchSvc = lim?.searchServices ?? [];
  // Capped at 2 here so the count drives both the gauges and their grid.
  const svcGauges = searchSvc.slice(0, 2);
  const searchAcct = lim?.searchAccount;
  const coverage = lim?.searchCoverage ?? [];
  const taxonomy = lim?.errorTaxonomy ?? [];
  const topUsers = lim?.topUsers ?? [];
  const topRoles = lim?.topRoles ?? [];
  const warnPct = lim?.config?.warnPct ?? 60;
  const pagePct = lim?.config?.pagePct ?? 80;

  /**
   * Binding constraint: the ceiling closest to being hit. The single most useful
   * number on the page, because the limits apply simultaneously and an agent
   * request fails if ANY of them is breached - so the closest ceiling governs
   * capacity and an average across them would be meaningless.
   */
  const binding = useMemo(() => {
    const candidates: Array<{ name: string; pct: number; detail: string }> = [];
    if (agentApi?.rpmLimit) {
      candidates.push({
        name: "Agent API requests",
        pct: agentApi.pctRpm ?? 0,
        detail: `${fmtNum(agentApi.peakRpm)} / ${fmtNum(agentApi.rpmLimit)} RPM`,
      });
    }
    for (const m of models) {
      if (m.tpmLimit) {
        candidates.push({
          name: `${m.model} tokens`,
          pct: m.pctTpm ?? 0,
          detail: `${fmtNum(m.peakTpm)} / ${fmtNum(m.tpmLimit)} TPM`,
        });
      }
      // Per-model RPM is a separate simultaneous ceiling. A model can sit near
      // its request cap with plenty of token headroom, so omitting this would
      // report headroom while requests were being throttled.
      if (m.rpmLimit) {
        candidates.push({
          name: `${m.model} requests`,
          pct: m.pctRpm ?? 0,
          detail: `${fmtNum(m.peakRpm)} / ${fmtNum(m.rpmLimit)} RPM`,
        });
      }
    }
    for (const s of searchSvc) {
      candidates.push({
        name: `${s.serviceFqn.split(".").pop()} search`,
        pct: s.pctOfLimit ?? 0,
        detail: `${fmtNum(s.peakQps)} / ${fmtNum(s.limitQps)} QPS`,
      });
    }
    if (searchAcct?.limitQps) {
      candidates.push({
        name: "Search account-wide",
        pct: searchAcct.pctOfLimit ?? 0,
        detail: `${fmtNum(searchAcct.peakQps)} / ${fmtNum(searchAcct.limitQps)} QPS`,
      });
    }
    candidates.sort((a, b) => b.pct - a.pct);
    return candidates[0] ?? null;
  }, [models, agentApi, searchSvc, searchAcct]);

  /** Model TPM: peak vs limit as a grouped horizontal bar with a limit marker. */
  const modelOption = useMemo(() => {
    const names = models.map((m) => m.model);
    return {
      grid: { left: 118, right: 48, top: 8, bottom: 20 },
      tooltip: {
        ...TOOLTIP,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: never) => {
          const p = params as unknown as Array<{ dataIndex: number }>;
          const m = models[p[0]?.dataIndex ?? 0];
          if (!m) return "";
          return [
            `<b>${m.model}</b>`,
            `peak TPM   ${fmtNum(m.peakTpm)}`,
            `p99 / min  ${fmtNum(m.p99Tpm)}`,
            `p50 / min  ${fmtNum(m.p50Tpm)}`,
            `TPM limit  ${fmtNum(m.tpmLimit)}`,
            `used       ${fmtPct(m.pctTpm, 2)}`,
            `total tok  ${fmtNum(m.totalTokens)}`,
            `active min ${fmtNum(m.activeMinutes)}`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "log",
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtNum(v) },
        min: 1,
      },
      yAxis: {
        type: "category",
        data: names,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, fontSize: 10 },
      },
      series: [
        {
          name: "TPM limit",
          type: "bar",
          data: models.map((m) => m.tpmLimit),
          itemStyle: { color: "#161e28" },
          barGap: "-100%",
          barMaxWidth: 16,
          silent: true,
          z: 1,
        },
        {
          name: "Peak TPM",
          type: "bar",
          data: models.map((m) => ({
            value: Math.max(m.peakTpm, 1),
            itemStyle: {
              color:
                m.pctTpm >= pagePct ? "#ff5a5f" : m.pctTpm >= warnPct ? "#ffc53d" : "#4fb8c9",
            },
          })),
          barMaxWidth: 16,
          z: 2,
          label: {
            show: true,
            position: "right",
            formatter: (p: never) => {
              const i = (p as unknown as { dataIndex: number }).dataIndex;
              return fmtPct(models[i]?.pctTpm ?? 0, 2);
            },
            color: "#6b7a8b",
            fontSize: 10,
            fontFamily: "var(--font-mono), monospace",
          },
        },
      ],
    };
  }, [models, warnPct, pagePct]);

  /** Error taxonomy: stacked by failing stage. */
  const taxonomyOption = useMemo(() => {
    const classes = Array.from(new Set(taxonomy.map((t: { errorClass: string }) => t.errorClass)));
    const stages = Array.from(new Set(taxonomy.map((t: { failingStage: string }) => t.failingStage)));
    const palette = ["#d98c6a", "#c8b88a", "#8e9bb0", "#5f7d95", "#4fb8c9", "#7ad7f0"];
    return {
      grid: { left: 150, right: 24, top: 8, bottom: 22 },
      tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        show: stages.length > 1,
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: { type: "value", ...AXIS, minInterval: 1 },
      yAxis: { type: "category", data: classes, ...AXIS },
      series: stages.map((stage, i) => ({
        name: String(stage),
        type: "bar" as const,
        stack: "total",
        barMaxWidth: 18,
        itemStyle: { color: palette[i % palette.length] },
        data: classes.map(
          (c) =>
            taxonomy
              .filter(
                (t: { errorClass: string; failingStage: string }) =>
                  t.errorClass === c && t.failingStage === stage,
              )
              .reduce((s: number, t: { n: number }) => s + t.n, 0) || 0,
        ),
      })),
    };
  }, [taxonomy]);

  const sparkOption = useMemo(
    () => ({
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: "category", show: false, data: trend.map((t) => t.ts) },
      yAxis: { type: "value", show: false },
      tooltip: { ...TOOLTIP, trigger: "axis", formatter: (p: never) => {
        const pt = (p as unknown as Array<{ dataIndex: number }>)[0];
        const row = trend[pt?.dataIndex ?? 0];
        return row ? `${axisLabel(row.ts, win)} · ${row.requests} req` : "";
      } },
      series: [
        {
          type: "line",
          data: trend.map((t) => t.requests),
          smooth: 0.3,
          symbol: "none",
          lineStyle: { width: 1.5, color: "#7ad7f0", shadowBlur: 8, shadowColor: "#7ad7f0" },
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(122,215,240,0.28)" },
                { offset: 1, color: "rgba(122,215,240,0)" },
              ],
            },
          },
        },
      ],
    }),
    [trend, win],
  );

  const errorTrendOption = useMemo(
    () => ({
      grid: { left: 40, right: 12, top: 18, bottom: 22 },
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: {
        show: true,
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 10, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: {
        type: "category",
        data: trend.map((t) => axisLabel(t.ts, win)),
        ...AXIS,
      },
      yAxis: { type: "value", ...AXIS, minInterval: 1 },
      series: [
        {
          name: "Requests",
          type: "bar",
          data: trend.map((t) => t.requests),
          itemStyle: { color: "#2c3a48" },
          barMaxWidth: 18,
        },
        {
          name: "Request errors",
          type: "bar",
          stack: "err",
          data: trend.map((t) => t.requestErrors),
          itemStyle: { color: "#ff5a5f" },
          barMaxWidth: 18,
        },
        {
          name: "Tool errors",
          type: "bar",
          stack: "err",
          data: trend.map((t) => t.toolErrors),
          itemStyle: { color: "#ffc53d" },
          barMaxWidth: 18,
        },
      ],
    }),
    [trend, win],
  );

  if (error) {
    return (
      <div className="panel border-st-critical/40 p-4">
        <div className="label-micro mb-1 text-st-critical">Fleet query failed</div>
        <pre className="overflow-x-auto font-mono text-[11px] text-ink">{String(error)}</pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- binding constraint banner ----------
          First thing on the page: the ceiling closest to being hit. An admin
          should not have to read four gauges to learn whether the system is
          under strain. */}
      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
        <div>
          <div className="label-micro">Binding Constraint</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className="font-mono text-[20px] leading-none"
              style={{
                color:
                  (binding?.pct ?? 0) >= pagePct
                    ? "#ff5a5f"
                    : (binding?.pct ?? 0) >= warnPct
                      ? "#ffc53d"
                      : "#2fd8a6",
              }}
            >
              {binding ? fmtPct(binding.pct, 1) : "—"}
            </span>
            <span className="font-mono text-[12px] text-ink">{binding?.name ?? "no traffic"}</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{binding?.detail}</div>
        </div>
        <p className="max-w-[70ch] flex-1 font-mono text-[10px] leading-relaxed text-ink-faint">
          All ceilings below apply <span className="text-ink">simultaneously</span>. An agent request
          is throttled if any single one is breached, so the closest ceiling governs capacity — not
          the average across them. Per-model TPM/RPM is consumed by{" "}
          <span className="text-ink">all inference in the account</span>, not only agent traffic, so
          agent usage is a share of that ceiling rather than the whole of it.
        </p>
      </div>

      {/* A limits failure must not blank the whole dashboard - the fleet half of
          the page is served by a different query and is still valid. */}
      {limError && (
        <div className="panel border-st-critical/40 px-3 py-2">
          <div className="label-micro mb-1 text-st-critical">Ceiling data unavailable</div>
          <pre className="overflow-x-auto font-mono text-[10px] text-ink">{String(limError)}</pre>
        </div>
      )}

      {/* ---------- KPI row ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Agent Requests"
          value={isPending ? null : (k?.requests ?? 0)}
          subvalue={
            k?.evalTurnsInWindow
              ? `${k.evalTurnsInWindow} eval-harness turns excluded`
              : undefined
          }
          detail={`p50 ${fmtMs(k?.p50Ms)} · p95 ${fmtMs(k?.p95Ms)} · p99 ${fmtMs(k?.p99Ms)}`}
          description="The number of individual requests, or turns, made to a Cortex Agent. One turn is a single prompt-and-response cycle, not a whole conversation — a session of several back-and-forth messages counts as several requests."
          sql={explainRequests(win, data?.config?.excludeEvalRuns ?? true)}
          hint="Counted as root AgentV2RequestResponseInfo spans. Latency percentiles are computed over successful turns only."
          spark={trend.length > 1 ? <Chart option={sparkOption} height={34} /> : undefined}
        />

        <KpiCard
          label="Active Agents"
          value={isPending ? null : (k?.activeAgents ?? 0)}
          suffix={k?.totalAgents ? `/ ${k.totalAgents}` : undefined}
          description="The number of distinct Cortex Agents that served at least one request in the window, shown against the total number of agents in the account."
          sql={explainActiveAgents(win, data?.config?.excludeEvalRuns ?? true)}
          hint="Counted on agent_fqn (database.schema.name). The total comes from SHOW AGENTS IN ACCOUNT and is NOT filtered by the window, so an agent that has never served a request still counts toward it."
        />

        <KpiCard
          label="Agent Cost"
          // null (not 0) when nothing is metered, so the tile renders an em-dash.
          // ACCOUNT_USAGE lags up to an hour, so the 60m window is normally
          // unmetered even during live traffic - "$0.00" there would read as
          // "nothing was spent" rather than "not billed yet".
          value={isPending ? null : (cost?.usd ?? null)}
          format={{ style: "currency", currency: "USD", maximumFractionDigits: 2 }}
          subvalue={costSplit ?? "awaiting metering (up to 1h)"}
          subcolor={costSplit ? "var(--color-ink-lo)" : "var(--color-ink-faint)"}
          detail={
            cost?.metered
              ? `${(cost.credits ?? 0).toFixed(1)} AI credits · ${cost.pricedRequests} priced · $${cost.usdPerAiCredit.toFixed(2)}/credit`
              : undefined
          }
          description="The estimated cost of all agent requests in the window, priced from the credits Snowflake metered for each request, then split by where that spend went."
          sql={explainCost(win, data?.config?.excludeEvalRuns ?? true, cost?.usdPerAiCredit ?? 2)}
          infoAlign="right"
          hint="Token credits only. Excludes warehouse compute for SQL the agents ran, and Cortex Search serving. Percentages are shares of SPEND, not of tokens - cache writes are ~19% of tokens but ~64% of cost. Metering lags up to 1 hour."
        />

        {/* Two error rates, because they measure different things. The root span
            reports 200 on every turn in this account, so request-level failure
            surfaces only via status.description, while a tool can fail inside an
            otherwise successful turn.

            Hand-rolled rather than a KpiCard because it renders two values side by
            side. The info affordance is the shared MetricInfo so it matches the
            other three tiles exactly. No overflow-hidden here, so the popover
            needs no wrapper to escape. */}
        <div className="panel relative flex flex-col gap-1 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="label-micro">Error Rate</span>
            <MetricInfo
              label="Error Rate"
              align="right"
              description="The share of agent requests in the window that failed, split by where the failure happened: Request is the whole turn failing, Tool is an individual step failing inside a turn that still returned."
              sql={explainErrorRates(win, data?.config?.excludeEvalRuns ?? true)}
              hint="Reported separately, never blended. A turn can survive a failed tool, so the two rates share a denominator but are not additive - the same turn can appear in both. Request-level failure is read from status.description because the root span returns status.code 200 on every turn in this account."
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
            {k?.requestErrors ?? 0} req · {k?.toolErrorTurns ?? 0} tool · {k?.degradedSuccess ?? 0}{" "}
            degraded
          </div>
        </div>
      </div>

      {/* ---------- request + error trend ---------- */}
      <Panel
        title={`Request Volume & Errors · ${win.toUpperCase()}`}
        hint="Request bars are total turns. Error bars are stacked separately so a tool failure inside a successful turn is visible without inflating the request-level error count."
      >
        <Chart option={errorTrendOption} height={200} empty={trend.length === 0} />
      </Panel>

      {/* ---------- the ceilings ----------
          The gauge count is variable - 2 fixed plus up to 2 search services -
          so the old fixed `xl:grid-cols-4` left half the row empty whenever
          fewer than 4 rendered. auto-fit is the usual fix but it sizes tracks
          from the container width rather than the item count, which puts 4
          gauges at ~1000px into 3 + 1 orphan. Driving the column count off the
          actual count keeps every row full at every breakpoint. */}
      <div className={`grid gap-3 ${GAUGE_COLS[2 + svcGauges.length] ?? GAUGE_COLS[4]}`}>
        <SaturationGauge
          label="Agent API · requests per minute"
          pct={agentApi?.pctRpm ?? 0}
          peak={agentApi?.peakRpm ?? 0}
          limit={agentApi?.rpmLimit ?? 500}
          p50={agentApi?.p50Rpm}
          p99={agentApi?.p99Rpm}
          unit="Account-wide cap across every Cortex Agent."
          source={agentApi?.source}
          warnPct={warnPct}
          pagePct={pagePct}
          note="Applies in addition to the orchestration model's own limits."
        />

        <SaturationGauge
          label="Cortex Search · account-wide QPS"
          pct={searchAcct?.pctOfLimit ?? 0}
          peak={searchAcct?.peakQps ?? 0}
          limit={searchAcct?.limitQps ?? 140}
          p50={searchAcct?.p50Qps}
          p99={searchAcct?.p99Qps}
          unit="Summed across all services within each second, then peaked."
          source={searchAcct?.source}
          warnPct={warnPct}
          pagePct={pagePct}
        />

        {svcGauges.map(
          (s: {
            serviceFqn: string;
            pctOfLimit: number;
            peakQps: number;
            limitQps: number;
            p50Qps: number;
            p99Qps: number;
            pct429: number;
            n429: number;
          }) => (
            <SaturationGauge
              key={s.serviceFqn}
              label={`Search · ${s.serviceFqn.split(".").pop()}`}
              pct={s.pctOfLimit}
              peak={s.peakQps}
              limit={s.limitQps}
              p50={s.p50Qps}
              p99={s.p99Qps}
              unit="Per-service QPS ceiling, bucketed per second."
              source="public_docs"
              warnPct={warnPct}
              pagePct={pagePct}
              note={s.n429 > 0 ? `${fmtPct(s.pct429, 1)} of requests returned 429` : undefined}
            />
          ),
        )}
      </div>

      {/* ---------- per-model TPM ---------- */}
      <Panel
        title={`Per-model token ceilings · ${win.toUpperCase()}`}
        hint="Peak tokens in any single minute versus the model's TPM limit read live from SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_RATE_LIMIT_POLICIES. Log scale, because limits span 100K to 40M."
        right={<SourceBadge source="account_view" />}
      >
        <Chart
          option={modelOption}
          height={Math.max(140, models.length * 34 + 40)}
          empty={models.length === 0}
        />
        {models.length > 0 && (
          <div className="mt-2 border-t border-line-faint pt-2 font-mono text-[10px] text-ink-faint">
            Reading:{" "}
            <SaturationReading
              peakPct={models[0].pctTpm}
              p50={models[0].p50Tpm}
              peak={models[0].peakTpm}
              warnPct={warnPct}
            />
          </div>
        )}
      </Panel>

      {/* ---------- search detail table ---------- */}
      <Panel
        title="Cortex Search · service detail"
        hint="Latency is split by status. Throttled requests are often FASTER than successful ones because a 429 short-circuits, so a blended average would improve during an incident."
      >
        {searchSvc.length === 0 ? (
          <div className="label-micro py-6 text-center">
            No search requests logged in this window
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px]">
              <thead>
                <tr className="border-b border-line text-ink-faint">
                  <th className="py-1 pr-3 font-400">Service</th>
                  <th className="py-1 pr-3 text-right font-400">Requests</th>
                  <th className="py-1 pr-3 text-right font-400">429s</th>
                  <th className="py-1 pr-3 text-right font-400">Peak QPS</th>
                  <th className="py-1 pr-3 text-right font-400">% of 20</th>
                  <th className="py-1 pr-3 text-right font-400">p50 ok</th>
                  <th className="py-1 pr-3 text-right font-400">p95 ok</th>
                  <th className="py-1 text-right font-400">p95 429</th>
                </tr>
              </thead>
              <tbody>
                {searchSvc.map(
                  (s: {
                    serviceFqn: string;
                    totalReq: number;
                    n429: number;
                    pct429: number;
                    peakQps: number;
                    pctOfLimit: number;
                    p50OkMs: number;
                    p95OkMs: number;
                    p95ThrottledMs: number;
                  }) => (
                    <tr key={s.serviceFqn} className="border-b border-line-faint last:border-0">
                      <td className="py-1.5 pr-3 text-ink" title={s.serviceFqn}>
                        {s.serviceFqn.split(".").slice(-2).join(".")}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-ink-hi">
                        {fmtNum(s.totalReq)}
                      </td>
                      <td
                        className="py-1.5 pr-3 text-right"
                        style={{ color: s.pct429 > 5 ? "#ff5a5f" : "var(--color-ink)" }}
                      >
                        {fmtNum(s.n429)} ({fmtPct(s.pct429, 0)})
                      </td>
                      <td className="py-1.5 pr-3 text-right text-ink">{fmtNum(s.peakQps)}</td>
                      <td
                        className="py-1.5 pr-3 text-right"
                        style={{
                          color:
                            s.pctOfLimit >= 100
                              ? "#ff5a5f"
                              : s.pctOfLimit >= warnPct
                                ? "#ffc53d"
                                : "var(--color-ink)",
                        }}
                      >
                        {fmtPct(s.pctOfLimit, 0)}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-ink-lo">{fmtMs(s.p50OkMs)}</td>
                      <td className="py-1.5 pr-3 text-right text-ink-lo">{fmtMs(s.p95OkMs)}</td>
                      <td className="py-1.5 text-right text-ink-faint">
                        {fmtMs(s.p95ThrottledMs)}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* coverage honesty note */}
        <p className="mt-2 border-t border-line-faint pt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
          QPS is only observable for services with{" "}
          <span className="text-ink">REQUEST_LOGGING = TRUE</span>. {coverage.length} service
          {coverage.length === 1 ? "" : "s"} in this account
          {coverage.length === 1 ? " has" : " have"} emitted request rows. Services with logging off
          contribute no data and are absent above rather than shown as zero.
        </p>
      </Panel>

      {/* ---------- errors + users + roles ---------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Error taxonomy"
          hint="Grouped by the stage that DETECTED the failure, using the failure descriptions actually present in this account. Not a speculative root-cause model."
        >
          <Chart
            option={taxonomyOption}
            height={Math.max(160, taxonomy.length * 26 + 50)}
            empty={taxonomy.length === 0}
          />
        </Panel>

        <div className="grid gap-3 sm:grid-cols-2">
          <Panel title="Top users" hint="Agent turns per user in the window.">
            <BarList
              rows={topUsers}
              labelKey="name"
              valueKey="requests"
              secondary={(r) =>
                Number(r.errors) > 0 ? `${r.errors} err` : fmtMs(Number(r.p95Ms))
              }
            />
          </Panel>
          <Panel title="Top roles" hint="Agent turns per primary role in the window.">
            <BarList
              rows={topRoles}
              labelKey="name"
              valueKey="requests"
              color="#c8b88a"
              secondary={(r) => `${r.agentsUsed} agents`}
            />
          </Panel>
        </div>
      </div>

      {/* ---------- hex fleet ----------
          Deliberately last. Everything above is driven by the window selector at
          the top of the page; this panel is NOT - it measures recency against
          SYSDATE() using FLEET_CONFIG thresholds and ignores the selector
          entirely. Keeping it below every windowed panel stops the page implying
          the selector reaches it. */}
      <Panel
        title="Agent Fleet"
        hint="Hex state uses thresholds from FLEET_CONFIG, measured against now — NOT the selected window. CRITICAL takes precedence over NOMINAL and IDLE."
        right={
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2.5 sm:flex">
              {(["NOMINAL", "IDLE", "CRITICAL", "OFF"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <StatusPill state={s} />
                  <span className="font-mono text-[10px] text-ink-faint">{counts[s] ?? 0}</span>
                </span>
              ))}
            </div>
            <button
              onClick={() => setShowConfig((v) => !v)}
              className="rounded-chip border border-line px-1.5 py-[2px] font-mono text-[10px] text-ink-lo transition-colors hover:border-line-strong hover:text-ink"
            >
              Thresholds
            </button>
          </div>
        }
      >
        {showConfig && (
          <div className="mb-3">
            <HexConfigPopover config={data?.config} onClose={() => setShowConfig(false)} />
          </div>
        )}
        <HexFleet agents={hex} />
      </Panel>
    </div>
  );
}
