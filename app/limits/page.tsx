"use client";

import { useMemo } from "react";
import { useLimitTrends } from "@/lib/hooks";
import { useShell } from "@/components/console/console-shell";
import { Chart, Panel, SourceBadge, type ChartOption } from "@/components/ui/chart";
import { CeilingTrend, NoCeilingData, type CeilingPoint } from "@/components/fleet/ceiling-trend";
import { AXIS, TOOLTIP, fmtNum, fmtMs, fmtPct, axisLabel } from "@/lib/echarts";

type ModelSeries = {
  model: string;
  tpmLimit: number;
  rpmLimit: number;
  peakPctTpm: number;
  peakPctRpm: number;
  points: Array<{
    ts: string | null;
    peakTpm: number;
    peakRpm: number;
    p50Tpm: number;
    activeMinutes: number;
    pctTpm: number;
    pctRpm: number;
  }>;
};

type SvcSeries = {
  serviceFqn: string;
  limitQps: number;
  peakPct: number;
  points: Array<{
    ts: string | null;
    peakQps: number;
    p50Qps: number;
    activeSeconds: number;
    pctOfLimit: number;
  }>;
};

type ThrottlePoint = {
  ts: string | null;
  totalReq: number;
  n429: number;
  pct429: number;
  p95OkMs: number | null;
  p95ThrottledMs: number | null;
};

/**
 * Saturation over time - the "WHEN" page.
 *
 * Home answers "is anything close to a ceiling right now?". This page answers
 * "when did it get close, and what did it cost?", so an admin can locate the
 * incident window before pivoting to the taxonomy and user/role panels on home.
 *
 * Every bar here is a PEAK sub-bucket, never an average. See the PAGE 2 header
 * in lib/fleet-sql.ts for why that distinction is load-bearing.
 */
export default function LimitsPage() {
  const { window: win } = useShell();
  const { data, error } = useLimitTrends(win);

  const agentApi = data?.agentApi;
  const models: ModelSeries[] = data?.models ?? [];
  const searchSvc: SvcSeries[] = data?.searchServices ?? [];
  const searchAcct = data?.searchAccount;
  const throttle: ThrottlePoint[] = data?.throttle ?? [];
  const coverage = data?.searchCoverage ?? [];
  const warnPct = data?.config?.warnPct ?? 60;
  const pagePct = data?.config?.pagePct ?? 80;

  /**
   * Per-service QPS as one chart. All services share the same 20 QPS ceiling, so
   * unlike the per-model case a single axis and a single limit line are correct.
   */
  const svcOption = useMemo<ChartOption>(() => {
    const buckets = Array.from(
      new Set(searchSvc.flatMap((s) => s.points.map((p) => p.ts))),
    ).sort() as string[];
    const limit = searchSvc[0]?.limitQps ?? 20;
    const peakMax = Math.max(0, ...searchSvc.flatMap((s) => s.points.map((p) => p.peakQps)));
    const palette = ["#7ad7f0", "#4fb8c9", "#c8b88a", "#d98c6a", "#8e9bb0", "#5f7d95"];

    return {
      grid: { left: 52, right: 16, top: 10, bottom: 22 },
      tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        show: searchSvc.length > 1,
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: { type: "category", data: buckets.map((b) => axisLabel(b, win)), ...AXIS },
      yAxis: {
        type: "value",
        max: Math.max(peakMax, limit) * 1.08,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtNum(v) },
      },
      series: searchSvc.map((s, i) => ({
        name: s.serviceFqn.split(".").pop(),
        type: "bar" as const,
        barMaxWidth: 22,
        itemStyle: { color: palette[i % palette.length] },
        data: buckets.map((b) => s.points.find((p) => p.ts === b)?.peakQps ?? null),
        ...(i === 0
          ? {
              markLine: {
                silent: true,
                symbol: "none",
                data: [{ yAxis: limit }],
                lineStyle: { color: "#ff5a5f", type: "dashed" as const, width: 1, opacity: 0.75 },
                label: {
                  show: true,
                  position: "insideEndTop" as const,
                  formatter: `per-service limit ${limit} QPS`,
                  color: "#ff5a5f",
                  fontSize: 9,
                  fontFamily: "var(--font-mono), monospace",
                },
              },
            }
          : {}),
      })),
    };
  }, [searchSvc, win]);

  /** Throttling: 429 count as bars, 429 rate as a line on a second axis. */
  const throttleOption = useMemo<ChartOption>(
    () => ({
      grid: { left: 52, right: 46, top: 14, bottom: 22 },
      tooltip: {
        ...TOOLTIP,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: never) => {
          const p = params as unknown as Array<{ dataIndex: number }>;
          const row = throttle[p[0]?.dataIndex ?? 0];
          if (!row) return "";
          return [
            `<b>${axisLabel(row.ts, win)}</b>`,
            `requests   ${fmtNum(row.totalReq)}`,
            `429s       ${fmtNum(row.n429)}`,
            `rate       ${fmtPct(row.pct429, 1)}`,
            `p95 ok     ${fmtMs(row.p95OkMs)}`,
            `p95 429    ${fmtMs(row.p95ThrottledMs)}`,
          ].join("<br/>");
        },
      },
      legend: {
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: { type: "category", data: throttle.map((t) => axisLabel(t.ts, win)), ...AXIS },
      yAxis: [
        {
          type: "value",
          ...AXIS,
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => fmtNum(v) },
        },
        {
          type: "value",
          max: 100,
          ...AXIS,
          splitLine: { show: false },
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => `${v}%` },
        },
      ],
      series: [
        {
          name: "Requests",
          type: "bar",
          data: throttle.map((t) => t.totalReq - t.n429),
          stack: "req",
          itemStyle: { color: "#2c3a48" },
          barMaxWidth: 22,
        },
        {
          name: "429s",
          type: "bar",
          data: throttle.map((t) => t.n429),
          stack: "req",
          itemStyle: { color: "#ff5a5f" },
          barMaxWidth: 22,
        },
        {
          name: "429 rate",
          type: "line",
          yAxisIndex: 1,
          data: throttle.map((t) => t.pct429),
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { color: "#ffc53d", width: 1.5 },
          itemStyle: { color: "#ffc53d" },
        },
      ],
    }),
    [throttle, win],
  );

  if (error) {
    return (
      <div className="panel border-st-critical/40 p-4">
        <div className="label-micro mb-1 text-st-critical">Saturation trend query failed</div>
        <pre className="overflow-x-auto font-mono text-[11px] text-ink">{String(error)}</pre>
      </div>
    );
  }

  const agentPoints: CeilingPoint[] = agentApi?.points ?? [];
  const acctPoints: CeilingPoint[] = searchAcct?.points ?? [];

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- how to read this page ---------- */}
      <div className="panel px-3 py-2.5">
        <div className="label-micro">Saturation over time · {win.toUpperCase()}</div>
        <p className="mt-1 max-w-[100ch] font-mono text-[10px] leading-relaxed text-ink-faint">
          Every bar is the <span className="text-ink">peak</span> sub-bucket inside that period —
          peak per minute for RPM and TPM, peak per <span className="text-ink">second</span> for
          QPS — because that is the granularity each limit is actually enforced at. These are never
          averages: averaging the real incident in this account turns a 409 QPS breach into roughly
          7. Dashed red lines are ceilings, not data. Current standing versus each ceiling lives on
          the home page; this page is for locating <span className="text-ink">when</span> pressure
          occurred.
        </p>
      </div>

      {/* ---------- ceiling 1: Agent API RPM ---------- */}
      <Panel
        title={`Agent API · requests per minute over time · ${win.toUpperCase()}`}
        hint="Peak agent requests in any single minute of each bucket, against the account-wide Agent API cap. This ceiling applies in addition to the orchestration model's own limits."
        right={<SourceBadge source={agentApi?.source ?? null} />}
      >
        {agentPoints.length === 0 ? (
          <NoCeilingData what="No agent requests in this window" />
        ) : (
          <CeilingTrend
            points={agentPoints}
            limit={agentApi?.limit ?? 500}
            unit="RPM"
            window={win}
            warnPct={warnPct}
            pagePct={pagePct}
          />
        )}
      </Panel>

      {/* ---------- ceiling 2: per-model TPM, small multiples ----------
          One chart per model rather than one shared chart: per-model ceilings
          range from 3M to 40M TPM, so a single axis would either flatten the
          smaller models or need a limit line per series. Pinning each y-axis to
          that model's own limit makes "how full is it" readable at a glance. */}
      <Panel
        title={`Per-model token ceilings over time · ${win.toUpperCase()}`}
        hint="One panel per model, each y-axis pinned to that model's own TPM limit. Limits are read live from SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_RATE_LIMIT_POLICIES. Remember this quota is consumed by ALL account inference, not only agent traffic."
        right={<SourceBadge source="account_view" />}
      >
        {models.length === 0 ? (
          <NoCeilingData what="No model inference recorded in this window" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {models.map((m) => (
              <div key={m.model} className="min-w-0">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[11px] text-ink">{m.model}</span>
                  <span className="font-mono text-[10px] text-ink-faint">
                    peak {fmtPct(m.peakPctTpm, 1)} of {fmtNum(m.tpmLimit)} TPM
                  </span>
                </div>
                <CeilingTrend
                  points={m.points.map((p) => ({
                    ts: p.ts,
                    peak: p.peakTpm,
                    p50: p.p50Tpm,
                    pctOfLimit: p.pctTpm,
                    activeSubBuckets: p.activeMinutes,
                  }))}
                  limit={m.tpmLimit}
                  unit="TPM"
                  window={win}
                  warnPct={warnPct}
                  pagePct={pagePct}
                  height={150}
                />
                <div className="mt-1 font-mono text-[10px] text-ink-faint">
                  Requests: peak {fmtPct(m.peakPctRpm, 2)} of {fmtNum(m.rpmLimit)} RPM — a separate
                  simultaneous ceiling.
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* ---------- ceiling 3a: per-service search QPS ---------- */}
      <Panel
        title={`Cortex Search · per-service QPS over time · ${win.toUpperCase()}`}
        hint="Peak requests in any single SECOND of each bucket. All services share the same per-service ceiling, so one axis and one limit line are correct here."
        right={<SourceBadge source="public_docs" />}
      >
        {searchSvc.length === 0 ? (
          <NoCeilingData what="No search requests logged in this window" />
        ) : (
          <>
            <Chart option={svcOption} height={190} />
            <div className="mt-2 border-t border-line-faint pt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
              {searchSvc.map((s) => {
                const worst = s.points.reduce(
                  (a, b) => (b.pctOfLimit > a.pctOfLimit ? b : a),
                  s.points[0],
                );
                return (
                  <div key={s.serviceFqn}>
                    <span className="text-ink">{s.serviceFqn.split(".").pop()}</span> worst bucket{" "}
                    <span className="text-ink">{axisLabel(worst?.ts ?? null, win)}</span> at{" "}
                    <span
                      style={{
                        color:
                          s.peakPct >= pagePct
                            ? "#ff5a5f"
                            : s.peakPct >= warnPct
                              ? "#ffc53d"
                              : "#2fd8a6",
                      }}
                    >
                      {fmtNum(worst?.peakQps)} QPS = {fmtPct(s.peakPct, 0)}
                    </span>{" "}
                    of the {fmtNum(s.limitQps)} QPS ceiling
                    {s.peakPct >= 100 && (
                      <span className="text-st-critical"> — breached, requests were throttled</span>
                    )}
                    .
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Panel>

      {/* ---------- ceiling 3b: account-wide search QPS ---------- */}
      <Panel
        title={`Cortex Search · account-wide QPS over time · ${win.toUpperCase()}`}
        hint="Requests are summed across all services WITHIN each second and only then peaked. Taking each service's max and adding them would overstate the peak, because different services peak in different seconds."
        right={<SourceBadge source={searchAcct?.source ?? null} />}
      >
        {acctPoints.length === 0 ? (
          <NoCeilingData what="No search requests logged in this window" />
        ) : (
          <CeilingTrend
            points={acctPoints}
            limit={searchAcct?.limit ?? 140}
            unit="QPS"
            window={win}
            warnPct={warnPct}
            pagePct={pagePct}
          />
        )}
      </Panel>

      {/* ---------- what the breaches cost ---------- */}
      <Panel
        title={`Throttling over time · ${win.toUpperCase()}`}
        hint="Not a ceiling check but its consequence: how many requests were actually rejected. A 429 rate is a ratio over requests, so this is the one chart on the page that is NOT a peak roll-up."
      >
        {throttle.length === 0 ? (
          <NoCeilingData what="No search requests logged in this window" />
        ) : (
          <>
            <Chart option={throttleOption} height={200} />
            <div className="mt-2 border-t border-line-faint pt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
              <table className="w-full text-left font-mono text-[10px]">
                <thead>
                  <tr className="text-ink-faint">
                    <th className="py-0.5 pr-3 font-400">Bucket</th>
                    <th className="py-0.5 pr-3 text-right font-400">Requests</th>
                    <th className="py-0.5 pr-3 text-right font-400">429s</th>
                    <th className="py-0.5 pr-3 text-right font-400">Rate</th>
                    <th className="py-0.5 pr-3 text-right font-400">p95 ok</th>
                    <th className="py-0.5 text-right font-400">p95 429</th>
                  </tr>
                </thead>
                <tbody>
                  {throttle.map((t) => (
                    <tr key={t.ts} className="border-t border-line-faint">
                      <td className="py-0.5 pr-3 text-ink">{axisLabel(t.ts, win)}</td>
                      <td className="py-0.5 pr-3 text-right text-ink-hi">{fmtNum(t.totalReq)}</td>
                      <td className="py-0.5 pr-3 text-right text-ink">{fmtNum(t.n429)}</td>
                      <td
                        className="py-0.5 pr-3 text-right"
                        style={{ color: t.pct429 > 5 ? "#ff5a5f" : "var(--color-ink)" }}
                      >
                        {fmtPct(t.pct429, 1)}
                      </td>
                      <td className="py-0.5 pr-3 text-right text-ink-lo">{fmtMs(t.p95OkMs)}</td>
                      <td className="py-0.5 text-right text-ink-faint">
                        {fmtMs(t.p95ThrottledMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 leading-relaxed">
                Latency is split by status on purpose. A 429 short-circuits, so throttled requests
                are typically <span className="text-ink">faster</span> than successful ones — a
                blended average would <span className="text-ink">improve</span> while most requests
                were failing.
              </p>
            </div>
          </>
        )}
      </Panel>

      {/* ---------- coverage honesty ---------- */}
      <div className="panel px-3 py-2">
        <p className="font-mono text-[10px] leading-relaxed text-ink-faint">
          Search QPS is only observable for services with{" "}
          <span className="text-ink">REQUEST_LOGGING = TRUE</span>. {coverage.length} service
          {coverage.length === 1 ? "" : "s"} in this account
          {coverage.length === 1 ? " has" : " have"} ever emitted request rows, so an empty search
          panel above means <span className="text-ink">not measured</span> rather than zero
          saturation. Agent API and per-model ceilings do not depend on this setting.
        </p>
      </div>
    </div>
  );
}
