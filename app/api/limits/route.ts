import { fleetQuery, parseConfig, num, str } from "@/lib/fleet-data";
import {
  Q_CONFIG,
  Q_SEARCH_COVERAGE,
  qTopUsers,
  qTopRoles,
  qErrorTaxonomy,
  qModelSaturation,
  qAgentApiSaturation,
  qSearchSaturation,
  qSearchAccountSaturation,
  isWindowKey,
  type WindowKey,
} from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/**
 * Ceiling/status payload, rendered on the HOME page.
 *
 * Shape is deliberately stable: scripts/verify.py asserts on `agentApi`,
 * `modelSaturation` and `searchServices`. Saturation over TIME lives on
 * `/api/limit-trends` instead, so neither route ships rows its consumer
 * never draws.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wParam = url.searchParams.get("window");
    const window: WindowKey = isWindowKey(wParam) ? wParam : "24h";

    const cfg = parseConfig(await fleetQuery(Q_CONFIG));
    const ex = cfg.excludeEvalRuns;

    const [users, roles, taxonomy, models, agentApi, searchSvc, searchAcct, coverage] =
      await Promise.all([
        fleetQuery(qTopUsers(window, ex)),
        fleetQuery(qTopRoles(window, ex)),
        fleetQuery(qErrorTaxonomy(window, ex)),
        fleetQuery(qModelSaturation(window, ex)),
        fleetQuery(qAgentApiSaturation(window, ex)),
        fleetQuery(qSearchSaturation(window)),
        fleetQuery(qSearchAccountSaturation(window)),
        fleetQuery(Q_SEARCH_COVERAGE),
      ]);

    const a = agentApi[0] ?? {};
    const sa = searchAcct[0] ?? {};

    return Response.json({
      window,
      config: cfg,
      topUsers: users.map((r) => ({
        name: str(r.USER_NAME),
        requests: num(r.REQUESTS),
        errors: num(r.ERRORS),
        p95Ms: num(r.P95_MS),
      })),
      topRoles: roles.map((r) => ({
        name: str(r.ROLE_NAME),
        requests: num(r.REQUESTS),
        errors: num(r.ERRORS),
        agentsUsed: num(r.AGENTS_USED),
      })),
      errorTaxonomy: taxonomy.map((r) => ({
        errorClass: str(r.ERROR_CLASS),
        failingStage: str(r.FAILING_STAGE),
        n: num(r.N),
        agents: num(r.AGENTS),
        lastSeen: str(r.LAST_SEEN),
        sample: str(r.SAMPLE_DESCRIPTION),
      })),
      // Ceiling 1: per-model Cortex REST limits, consumed by ALL account
      // inference. Agent traffic is a share of this, not the whole picture.
      modelSaturation: models.map((r) => ({
        model: str(r.MODEL_NAME),
        tpmLimit: num(r.TPM_LIMIT),
        rpmLimit: num(r.RPM_LIMIT),
        source: str(r.SOURCE),
        peakTpm: num(r.PEAK_TPM),
        peakRpm: num(r.PEAK_RPM),
        p50Tpm: num(r.P50_TPM),
        p99Tpm: num(r.P99_TPM),
        totalTokens: num(r.TOTAL_TOKENS),
        activeMinutes: num(r.ACTIVE_MINUTES),
        pctTpm: num(r.PCT_TPM_USED),
        pctRpm: num(r.PCT_RPM_USED),
      })),
      // Ceiling 2: Agent API request cap. Applies simultaneously with ceiling 1.
      agentApi: {
        rpmLimit: num(a.RPM_LIMIT),
        source: str(a.SOURCE),
        note: str(a.NOTE),
        peakRpm: num(a.PEAK_RPM),
        p50Rpm: num(a.P50_RPM),
        p99Rpm: num(a.P99_RPM),
        activeMinutes: num(a.ACTIVE_MINUTES),
        pctRpm: num(a.PCT_RPM_USED),
      },
      // Ceiling 3: Cortex Search QPS, per service and account-wide.
      searchServices: searchSvc.map((r) => ({
        serviceFqn: str(r.SERVICE_FQN),
        totalReq: num(r.TOTAL_REQ),
        n429: num(r.N_429),
        pct429: num(r.PCT_429),
        p50OkMs: num(r.P50_OK_MS),
        p95OkMs: num(r.P95_OK_MS),
        p95ThrottledMs: num(r.P95_429_MS),
        peakQps: num(r.PEAK_QPS),
        p50Qps: num(r.P50_QPS),
        p99Qps: num(r.P99_QPS),
        limitQps: num(r.SVC_QPS_LIMIT),
        pctOfLimit: num(r.PCT_OF_SVC_LIMIT),
        lastSeen: str(r.LAST_SEEN),
      })),
      searchAccount: {
        limitQps: num(sa.ACCT_QPS_LIMIT),
        source: str(sa.SOURCE),
        peakQps: num(sa.PEAK_QPS),
        p50Qps: num(sa.P50_QPS),
        p99Qps: num(sa.P99_QPS),
        pctOfLimit: num(sa.PCT_OF_ACCT_LIMIT),
      },
      // Honest coverage: services absent here have REQUEST_LOGGING off for the
      // period in question, so they contribute no QPS data.
      searchCoverage: coverage.map((r) => ({
        serviceFqn: str(r.SERVICE_FQN),
        totalReq: num(r.TOTAL_REQ),
        lastSeen: str(r.LAST_SEEN),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/limits]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
