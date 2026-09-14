import { fleetQuery, parseConfig, num, numOrNull, str } from "@/lib/fleet-data";
import {
  Q_CONFIG,
  Q_REFRESH_STATE,
  Q_COVERAGE,
  qKpis,
  qHexFleet,
  qRequestTrend,
  isWindowKey,
  WINDOWS,
  type WindowKey,
} from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/**
 * Page 1 payload. A single endpoint behind a single TanStack Query poll, so the
 * app runs one 10-minute timer rather than one per panel.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wParam = url.searchParams.get("window");
    const window: WindowKey = isWindowKey(wParam) ? wParam : "24h";

    const cfg = parseConfig(await fleetQuery(Q_CONFIG));
    const ex = cfg.excludeEvalRuns;

    const [refresh, coverage, kpis, hex, trend] = await Promise.all([
      fleetQuery(Q_REFRESH_STATE),
      fleetQuery(Q_COVERAGE),
      fleetQuery(qKpis(window, ex)),
      fleetQuery(
        qHexFleet(cfg.greenMinutes, cfg.yellowHours, cfg.redHours, cfg.redIncludesTool),
      ),
      fleetQuery(qRequestTrend(window, ex)),
    ]);

    const k = kpis[0] ?? {};
    const requests = num(k.REQUESTS);
    const requestErrors = num(k.REQUEST_ERRORS);
    const toolErrorTurns = num(k.TURNS_WITH_TOOL_ERROR);

    // Cost. Deliberately nullable end-to-end: the SQL returns NULL when no priced
    // request falls in the window, which is the normal state of the 60m window
    // because ACCOUNT_USAGE metering lags up to an hour. Coercing that to 0 would
    // render "$0.00" and read as "nothing was spent" during live traffic.
    const crInput = numOrNull(k.COST_CREDITS_INPUT);
    const crOutput = numOrNull(k.COST_CREDITS_OUTPUT);
    const crCacheRead = numOrNull(k.COST_CREDITS_CACHE_READ);
    const crCacheWrite = numOrNull(k.COST_CREDITS_CACHE_WRITE);
    const pricedRequests = num(k.COST_PRICED_REQUESTS);
    const metered = pricedRequests > 0;
    const credits = metered
      ? num(crInput) + num(crOutput) + num(crCacheRead) + num(crCacheWrite)
      : null;
    // Share of SPEND, not of tokens - the two rank completely differently. Cache
    // write is ~19% of tokens but ~64% of cost.
    const pct = (v: number | null) =>
      credits !== null && credits > 0 && v !== null ? (v / credits) * 100 : null;

    // Whether the selected window reaches past the oldest retained event. The
    // window is still honoured; this only lets the UI say so, rather than
    // presenting 176 days of data as though it were a full year.
    const cov = coverage[0] ?? {};
    const turnHistoryDays = num(cov.TURN_HISTORY_DAYS, -1);
    const spec = WINDOWS[window];
    const windowDays = spec.unit === "day" ? spec.n : spec.unit === "hour" ? spec.n / 24 : 0;

    return Response.json({
      window,
      windowLabel: spec.label,
      bucket: spec.bucket,
      config: cfg,
      coverage: {
        earliestTurnTs: str(cov.EARLIEST_TURN_TS),
        turnHistoryDays: turnHistoryDays >= 0 ? turnHistoryDays : null,
        earliestSearchTs: str(cov.EARLIEST_SEARCH_TS),
        searchHistoryDays: num(cov.SEARCH_HISTORY_DAYS, -1) >= 0 ? num(cov.SEARCH_HISTORY_DAYS) : null,
        windowExceedsHistory: turnHistoryDays >= 0 && windowDays > turnHistoryDays,
      },
      refresh: {
        refreshedAt: str(refresh[0]?.REFRESHED_AT),
        ageSeconds: num(refresh[0]?.AGE_SECONDS, -1),
        nTurns: num(refresh[0]?.N_TURNS),
        nSpans: num(refresh[0]?.N_SPANS),
        nSearch: num(refresh[0]?.N_SEARCH),
        servedBy: str(refresh[0]?.SERVED_BY),
      },
      kpis: {
        requests,
        activeAgents: num(k.ACTIVE_AGENTS),
        totalAgents: num(k.TOTAL_AGENTS),
        tokens: num(k.TOKENS),
        inputTokens: num(k.INPUT_TOKENS),
        outputTokens: num(k.OUTPUT_TOKENS),
        cacheReadTokens: num(k.CACHE_READ_TOKENS),
        cacheWriteTokens: num(k.CACHE_WRITE_TOKENS),
        planTokens: num(k.PLAN_TOKENS),
        requestErrors,
        toolErrorTurns,
        degradedSuccess: num(k.DEGRADED_SUCCESS),
        flaggedSlow: num(k.FLAGGED_SLOW),
        // Two distinct rates. The root span reports 200 on every turn in this
        // account, so request-level failure only shows via status.description,
        // while a tool can fail inside an otherwise successful turn.
        requestErrorRate: requests > 0 ? (requestErrors / requests) * 100 : null,
        toolErrorRate: requests > 0 ? (toolErrorTurns / requests) * 100 : null,
        p50Ms: num(k.P50_MS),
        p95Ms: num(k.P95_MS),
        p99Ms: num(k.P99_MS),
        evalTurnsInWindow: num(k.EVAL_TURNS_IN_WINDOW),
        // Prompt cache hit rate. cache_read is a SUBSET of input_tokens
        // (verified on 1349/1349 LLM spans), so the denominator is input alone.
        // Treating them as disjoint understates the rate badly - it reported
        // 43% where the true figure is 81%.
        cacheHitPct:
          num(k.INPUT_TOKENS) > 0
            ? (num(k.CACHE_READ_TOKENS) / num(k.INPUT_TOKENS)) * 100
            : null,
      },
      cost: {
        metered,
        pricedRequests,
        credits,
        usd: credits === null ? null : credits * cfg.usdPerAiCredit,
        usdPerAiCredit: cfg.usdPerAiCredit,
        creditsInput: crInput,
        creditsOutput: crOutput,
        creditsCacheRead: crCacheRead,
        creditsCacheWrite: crCacheWrite,
        pctInput: pct(crInput),
        pctOutput: pct(crOutput),
        pctCacheRead: pct(crCacheRead),
        pctCacheWrite: pct(crCacheWrite),
      },
      hex: hex.map((r) => ({
        agentFqn: str(r.AGENT_FQN),
        agentName: str(r.AGENT_NAME),
        displayName: str(r.DISPLAY_NAME) ?? str(r.AGENT_NAME),
        owner: str(r.AGENT_OWNER),
        profileColor: str(r.PROFILE_COLOR),
        state: str(r.HEX_STATE) ?? "OFF",
        turnsTotal: num(r.TURNS_TOTAL),
        distinctUsers: num(r.DISTINCT_USERS),
        lastTurnTs: str(r.LAST_TURN_TS),
        lastSuccessTs: str(r.LAST_SUCCESS_TS),
        lastRequestErrorTs: str(r.LAST_REQUEST_ERROR_TS),
        lastToolErrorTs: str(r.LAST_TOOL_ERROR_TS),
        minutesSinceLastTurn: r.MINUTES_SINCE_LAST_TURN === null ? null : num(r.MINUTES_SINCE_LAST_TURN),
      })),
      trend: trend.map((r) => ({
        ts: str(r.TS),
        requests: num(r.REQUESTS),
        requestErrors: num(r.REQUEST_ERRORS),
        toolErrors: num(r.TOOL_ERRORS),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/fleet]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
