import { fleetQuery, parseConfig, num, numOrNull, str, type Row } from "@/lib/fleet-data";
import {
  Q_CONFIG,
  Q_SEARCH_COVERAGE,
  qAgentApiTrend,
  qModelSaturationTrend,
  qSearchQpsTrend,
  qSearchAccountQpsTrend,
  qSearchThrottleTrend,
  isWindowKey,
  type WindowKey,
} from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/**
 * Saturation over time - the "WHEN did a ceiling get close?" payload.
 *
 * Deliberately carries no status/gauge data: those live on `/api/limits` and are
 * rendered on the home page. Keeping the split clean means neither route ships
 * rows its consumer never draws.
 *
 * Per-model and per-service series are returned pre-grouped, because each one
 * is drawn against its OWN ceiling - models have limits from 3M to 40M TPM, so
 * a flat row list would force the client to re-group before it could scale an
 * axis.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wParam = url.searchParams.get("window");
    const window: WindowKey = isWindowKey(wParam) ? wParam : "24h";

    const cfg = parseConfig(await fleetQuery(Q_CONFIG));
    const ex = cfg.excludeEvalRuns;

    const [agentApi, models, searchSvc, searchAcct, throttle, coverage] = await Promise.all([
      fleetQuery(qAgentApiTrend(window, ex)),
      fleetQuery(qModelSaturationTrend(window, ex)),
      fleetQuery(qSearchQpsTrend(window)),
      fleetQuery(qSearchAccountQpsTrend(window)),
      fleetQuery(qSearchThrottleTrend(window)),
      fleetQuery(Q_SEARCH_COVERAGE),
    ]);

    /** Group a flat result set into one series per key, preserving row order. */
    function groupBy<T>(rows: Row[], key: string, map: (r: Row) => T): Map<string, T[]> {
      const out = new Map<string, T[]>();
      for (const r of rows) {
        const k = str(r[key]) ?? "(unknown)";
        const list = out.get(k);
        if (list) list.push(map(r));
        else out.set(k, [map(r)]);
      }
      return out;
    }

    const modelSeries = groupBy(models, "MODEL_NAME", (r) => ({
      ts: str(r.TS),
      peakTpm: num(r.PEAK_TPM),
      peakRpm: num(r.PEAK_RPM),
      p50Tpm: num(r.P50_TPM),
      activeMinutes: num(r.ACTIVE_MINUTES),
      pctTpm: num(r.PCT_TPM),
      pctRpm: num(r.PCT_RPM),
    }));

    const svcSeries = groupBy(searchSvc, "SERVICE_FQN", (r) => ({
      ts: str(r.TS),
      peakQps: num(r.PEAK_QPS),
      p50Qps: num(r.P50_QPS),
      activeSeconds: num(r.ACTIVE_SECONDS),
      pctOfLimit: num(r.PCT_OF_LIMIT),
    }));

    // The limit is constant across every row of a series, so read it once.
    const firstFor = (rows: Row[], key: string, val: string) =>
      rows.find((r) => str(r[key]) === val) ?? {};

    return Response.json({
      window,
      config: cfg,

      // Ceiling 1: Agent API request cap, measured per minute.
      agentApi: {
        limit: num(agentApi[0]?.LIMIT_VALUE),
        source: str(agentApi[0]?.SOURCE),
        unit: "RPM",
        points: agentApi.map((r) => ({
          ts: str(r.TS),
          peak: num(r.PEAK_RPM),
          p50: num(r.P50_RPM),
          activeSubBuckets: num(r.ACTIVE_MINUTES),
          pctOfLimit: num(r.PCT_OF_LIMIT),
        })),
      },

      // Ceiling 2: per-model TPM/RPM. Each model carries its own ceilings so the
      // chart can pin its y-axis to that model's limit.
      models: [...modelSeries.entries()].map(([model, points]) => {
        const row = firstFor(models, "MODEL_NAME", model);
        return {
          model,
          tpmLimit: num(row.TPM_LIMIT),
          rpmLimit: num(row.RPM_LIMIT),
          peakPctTpm: Math.max(0, ...points.map((p) => p.pctTpm)),
          peakPctRpm: Math.max(0, ...points.map((p) => p.pctRpm)),
          points,
        };
      }),

      // Ceiling 3a: per-service search QPS, measured per second.
      searchServices: [...svcSeries.entries()].map(([serviceFqn, points]) => {
        const row = firstFor(searchSvc, "SERVICE_FQN", serviceFqn);
        return {
          serviceFqn,
          limitQps: num(row.LIMIT_VALUE),
          peakPct: Math.max(0, ...points.map((p) => p.pctOfLimit)),
          points,
        };
      }),

      // Ceiling 3b: account-wide search QPS, summed within each second first.
      searchAccount: {
        limit: num(searchAcct[0]?.LIMIT_VALUE),
        source: str(searchAcct[0]?.SOURCE),
        unit: "QPS",
        points: searchAcct.map((r) => ({
          ts: str(r.TS),
          peak: num(r.PEAK_QPS),
          p50: num(r.P50_QPS),
          activeSubBuckets: num(r.ACTIVE_SECONDS),
          pctOfLimit: num(r.PCT_OF_LIMIT),
        })),
      },

      // Consequence, not a ceiling: what the breaches actually cost. Latency is
      // split by status because a 429 short-circuits and is FASTER than success.
      throttle: throttle.map((r) => ({
        ts: str(r.TS),
        totalReq: num(r.TOTAL_REQ),
        n429: num(r.N_429),
        pct429: num(r.PCT_429),
        // numOrNull, not num: a bucket with no throttled requests has NO p95,
        // and coercing that to 0 would draw a 0ms latency point that never happened.
        p95OkMs: numOrNull(r.P95_OK_MS),
        p95ThrottledMs: numOrNull(r.P95_429_MS),
      })),

      // Honest coverage: QPS only exists for services with REQUEST_LOGGING = TRUE.
      searchCoverage: coverage.map((r) => ({
        serviceFqn: str(r.SERVICE_FQN),
        totalReq: num(r.TOTAL_REQ),
        lastSeen: str(r.LAST_SEEN),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/limit-trends]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
