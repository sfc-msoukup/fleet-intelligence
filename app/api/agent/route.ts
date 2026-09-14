import { fleetQuery, parseConfig, num, numOrNull, str } from "@/lib/fleet-data";
import {
  Q_CONFIG,
  Q_AGENT_LIST,
  Q_TRACE_SPANS,
  qAgentTrend,
  qAgentTokens,
  qAgentResources,
  qLatencyCohorts,
  qSlowTraces,
  qAgentUsersRoles,
  qAgentFeedbackTrend,
  qAgentKpis,
  isWindowKey,
  type WindowKey,
} from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/** Page 3 payload: per-agent deep dive. `agent` is bound, never interpolated. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wParam = url.searchParams.get("window");
    const window: WindowKey = isWindowKey(wParam) ? wParam : "24h";
    const agent = url.searchParams.get("agent");
    const traceId = url.searchParams.get("trace");

    const cfg = parseConfig(await fleetQuery(Q_CONFIG));
    const ex = cfg.excludeEvalRuns;
    const agents = await fleetQuery(Q_AGENT_LIST);

    const agentList = agents.map((r) => ({
      agentFqn: str(r.AGENT_FQN),
      displayName: str(r.DISPLAY_NAME) ?? str(r.AGENT_NAME),
      turnsTotal: num(r.TURNS_TOTAL),
    }));

    if (!agent) {
      return Response.json({ window, config: cfg, agents: agentList, agent: null });
    }

    // Identity for the banner. Read from the already-fetched inventory rather than
    // a second query - it is the authoritative agent roster (SHOW AGENTS) and
    // carries owner and profile colour. Null when the URL names an agent that no
    // longer exists, which the banner renders as an explicit "unknown agent".
    const inv = agents.find((r) => str(r.AGENT_FQN) === agent);
    const identity = inv
      ? {
          agentFqn: str(inv.AGENT_FQN),
          displayName: str(inv.DISPLAY_NAME) ?? str(inv.AGENT_NAME),
          agentName: str(inv.AGENT_NAME),
          database: str(inv.AGENT_DATABASE),
          schema: str(inv.AGENT_SCHEMA),
          owner: str(inv.AGENT_OWNER),
          profileColor: str(inv.PROFILE_COLOR),
          turnsTotal: num(inv.TURNS_TOTAL),
          distinctUsers: num(inv.DISTINCT_USERS),
          lastTurnTs: str(inv.LAST_TURN_TS),
        }
      : null;

    const [trend, tokens, resources, cohorts, slow, usersRoles, feedback, kpiRows] =
      await Promise.all([
        fleetQuery(qAgentTrend(window, ex), [agent]),
        fleetQuery(qAgentTokens(window, ex), [agent]),
        fleetQuery(qAgentResources(window, ex), [agent]),
        fleetQuery(qLatencyCohorts(window, ex), [agent]),
        fleetQuery(qSlowTraces(window, ex), [agent]),
        fleetQuery(qAgentUsersRoles(window, ex), [agent]),
        fleetQuery(qAgentFeedbackTrend(window), [agent]),
        fleetQuery(qAgentKpis(window, ex), [agent]),
      ]);

    // Only fetch a span tree when a trace is explicitly selected.
    const spans = traceId ? await fleetQuery(Q_TRACE_SPANS, [traceId]) : [];

    const kr = kpiRows[0] ?? {};
    const requests = num(kr.REQUESTS);
    const requestErrors = num(kr.REQUEST_ERRORS);
    const toolErrorTurns = num(kr.TURNS_WITH_TOOL_ERROR);
    const threads = num(kr.THREADS);
    const turnsInThreads = num(kr.TURNS_IN_THREADS);

    // Cost, nullable end to end for the same reason as the home page: SUM over
    // zero priced requests yields NULL, and ACCOUNT_USAGE metering lags up to an
    // hour, so a coerced 0 would read as "free" rather than "not billed yet".
    const crInput = numOrNull(kr.COST_CREDITS_INPUT);
    const crOutput = numOrNull(kr.COST_CREDITS_OUTPUT);
    const crCacheRead = numOrNull(kr.COST_CREDITS_CACHE_READ);
    const crCacheWrite = numOrNull(kr.COST_CREDITS_CACHE_WRITE);
    const pricedRequests = num(kr.COST_PRICED_REQUESTS);
    const metered = pricedRequests > 0;
    const credits = metered
      ? num(crInput) + num(crOutput) + num(crCacheRead) + num(crCacheWrite)
      : null;
    const pct = (v: number | null) =>
      credits !== null && credits > 0 && v !== null ? (v / credits) * 100 : null;

    return Response.json({
      window,
      config: cfg,
      agents: agentList,
      agent,
      identity,
      kpis: {
        requests,
        requestErrors,
        toolErrorTurns,
        degradedSuccess: num(kr.DEGRADED_SUCCESS),
        p95Ms: num(kr.P95_MS),
        requestErrorRate: requests > 0 ? (requestErrors / requests) * 100 : null,
        toolErrorRate: requests > 0 ? (toolErrorTurns / requests) * 100 : null,
        threads,
        turnsInThreads,
        threadlessTurns: num(kr.THREADLESS_TURNS),
        maxTurnsInThread: num(kr.MAX_TURNS_IN_THREAD),
        // Numerator is turns that BELONG to a thread, not all turns. thread_id is
        // not fully populated and COUNT(DISTINCT) skips NULLs, so dividing all
        // turns by distinct threads would credit threadless turns to threads that
        // never held them (3.77 vs the true 3.50 on the busiest agent here).
        turnsPerThread: threads > 0 ? turnsInThreads / threads : null,
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
      trend: trend.map((r) => ({
        ts: str(r.TS),
        requests: num(r.REQUESTS),
        requestErrors: num(r.REQUEST_ERRORS),
        toolErrors: num(r.TOOL_ERRORS),
        p50Ms: num(r.P50_MS),
        p95Ms: num(r.P95_MS),
      })),
      tokens: tokens.map((r) => ({
        ts: str(r.TS),
        cacheReadInput: num(r.CACHE_READ_INPUT_TOKENS),
        cacheWriteInput: num(r.CACHE_WRITE_INPUT_TOKENS),
        input: num(r.INPUT_TOKENS),
        freshInput: num(r.FRESH_INPUT_TOKENS),
        output: num(r.OUTPUT_TOKENS),
        plan: num(r.PLAN_TOKENS),
        total: num(r.TOTAL_TOKENS),
      })),
      resources: resources.map((r) => ({
        kind: str(r.KIND),
        name: str(r.NAME),
        n: num(r.N),
        p95Ms: num(r.P95_MS),
        errors: num(r.ERRORS),
      })),
      latencyCohorts: cohorts.map((r) => ({
        cohort: str(r.COHORT),
        spanCategory: str(r.SPAN_CATEGORY),
        spanCount: num(r.SPAN_COUNT),
        traces: num(r.TRACES),
        meanMsPerTrace: num(r.MEAN_MS_PER_TRACE),
        p95SpanMs: num(r.P95_SPAN_MS),
      })),
      slowTraces: slow.map((r) => ({
        traceId: str(r.TRACE_ID),
        ts: str(r.TURN_END_TS),
        durationMs: num(r.DURATION_MS),
        userName: str(r.USER_NAME),
        planningSteps: num(r.PLANNING_STEPS),
        isRequestError: Boolean(r.IS_REQUEST_ERROR),
        toolErrorCount: num(r.TOOL_ERROR_COUNT),
        totalTokens: num(r.TOTAL_TOKENS),
      })),
      usersRoles: usersRoles.map((r) => ({
        userName: str(r.USER_NAME),
        roleName: str(r.ROLE_NAME),
        requests: num(r.REQUESTS),
        errors: num(r.ERRORS),
        lastSeen: str(r.LAST_SEEN),
      })),
      feedback: feedback.map((r) => ({
        ts: str(r.TS),
        positive: num(r.POSITIVE),
        negative: num(r.NEGATIVE),
      })),
      traceId,
      spans: spans.map((r) => ({
        spanId: str(r.SPAN_ID),
        parentSpanId: str(r.PARENT_SPAN_ID),
        spanName: str(r.SPAN_NAME),
        spanCategory: str(r.SPAN_CATEGORY),
        startTs: str(r.START_TS),
        endTs: str(r.END_TS),
        latencyMs: numOrNull(r.LATENCY_MS),
        // Some spans emit start after end; the data layer nulls those. Surfaced
        // as a flag so the waterfall can exclude them visibly rather than
        // drawing a misleading zero-width bar.
        hasInvalidDuration: Boolean(r.HAS_INVALID_DURATION),
        stepNumber: r.STEP_NUMBER === null ? null : num(r.STEP_NUMBER),
        modelName: str(r.MODEL_NAME),
        toolStatus: str(r.TOOL_STATUS),
        toolStatusDescription: str(r.TOOL_STATUS_DESCRIPTION),
        planningStatus: str(r.PLANNING_STATUS),
        isToolError: Boolean(r.IS_TOOL_ERROR),
      })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/agent]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
