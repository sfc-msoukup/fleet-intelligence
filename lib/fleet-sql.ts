/**
 * Fleet SQL - the single source of truth for every metric the app renders.
 *
 * Correctness rules enforced here (validated against the live account):
 *
 * 1. SYSDATE() everywhere, never CURRENT_TIMESTAMP. The observability event
 *    TIMESTAMP columns are TIMESTAMP_NTZ in UTC while CURRENT_TIMESTAMP is
 *    session-local (UTC-7 here). Mixing them shifts every window by 7 hours.
 *
 * 2. Never join request-grain to bucket-grain without aggregating first.
 *    Doing so multiplies rows: an early version of the search saturation query
 *    reported 48.7M requests instead of 62,038.
 *
 * 3. Saturation uses MAX() over per-bucket counts, never AVG(). An hourly
 *    average hides a burst that breached a per-minute ceiling.
 *
 * 4. Bucket at the limit's own granularity: per MINUTE for TPM/RPM, per SECOND
 *    for Search QPS. Minute-bucketing the real incident in this account
 *    averaged a 409 QPS peak down to ~7.
 *
 * 5. Account-wide QPS sums across services within each second and then takes
 *    the max. Max-per-service-then-sum overstates the peak, because different
 *    services peak in different seconds.
 *
 * 6. Latency is always segmented by status and the mean is never reported.
 *    In this account throttled search requests were ~2x FASTER than successful
 *    ones (p95 196ms vs 351ms), so a blended average improved while 70% of
 *    requests were failing.
 */

/**
 * Fully-qualified schema that holds the FLEET_* tables and the refresh proc.
 *
 * Configurable via NEXT_PUBLIC_FLEET_SCHEMA so a fresh install can point the app
 * at its own database/schema (see setup.sql, which creates
 * FLEET_INTELLIGENCE.OBSERVABILITY). It must be NEXT_PUBLIC_ — this module is
 * imported by client components (the SQL popovers render these builders), so a
 * server-only env var would leave the browser bundle showing "undefined.FLEET_*".
 * NEXT_PUBLIC_ is inlined at BUILD time, so set it in the deploy's build phase.
 * Left unset it defaults to the schema this app was first deployed against.
 */
export const FLEET_SCHEMA =
  process.env.NEXT_PUBLIC_FLEET_SCHEMA ?? "SNOWFLAKE_INTELLIGENCE.AGENTS";

/**
 * Allowlisted analysis windows. Never interpolate user input into SQL.
 *
 * `bucket` is the trend granularity and is declared here rather than derived,
 * because it does not follow from the window length mechanically - it is chosen
 * so a trend series lands in the 24-90 point range that stays legible in a bar
 * chart. Daily buckets over a year would be 365 bars in a ~600px panel, which
 * renders as a solid block, so the long windows step down to weekly.
 *
 * This is the trend bucket ONLY. Saturation queries deliberately ignore it and
 * always bucket at their limit's own granularity - per MINUTE for TPM/RPM, per
 * SECOND for Search QPS (correctness rule 4 above). Widening the window must
 * never coarsen a ceiling check, or a breach averages away.
 */
export const WINDOWS = {
  "60m": { label: "60 MIN", unit: "minute", n: 60, bucket: "minute" },
  "24h": { label: "24 HOUR", unit: "hour", n: 24, bucket: "hour" },
  "7d": { label: "7 DAY", unit: "day", n: 7, bucket: "day" },
  "30d": { label: "30 DAY", unit: "day", n: 30, bucket: "day" },
  "90d": { label: "90 DAY", unit: "day", n: 90, bucket: "day" },
  "180d": { label: "180 DAY", unit: "day", n: 180, bucket: "week" },
  "365d": { label: "365 DAY", unit: "day", n: 365, bucket: "week" },
} as const;

export type WindowKey = keyof typeof WINDOWS;

/** Window keys in display order. Single source for every selector in the UI. */
export const WINDOW_KEYS = Object.keys(WINDOWS) as WindowKey[];

export function isWindowKey(v: unknown): v is WindowKey {
  return typeof v === "string" && Object.hasOwn(WINDOWS, v);
}

/** UTC-safe lower bound for a window. */
export function since(w: WindowKey): string {
  const { unit, n } = WINDOWS[w];
  return `DATEADD('${unit}', -${n}, SYSDATE())`;
}

/**
 * Time bucket for trend series over a window.
 *
 * Reads the declared value instead of re-deriving it, so the granularity for a
 * window is stated exactly once.
 */
export function bucket(w: WindowKey): string {
  return WINDOWS[w].bucket;
}

/* ---------------------------------------------------------------------------
   CONFIG
   ------------------------------------------------------------------------ */

export const Q_CONFIG = `
SELECT CONFIG_KEY, CONFIG_VALUE, VALUE_TYPE, DESCRIPTION
FROM ${FLEET_SCHEMA}.FLEET_CONFIG
ORDER BY CONFIG_KEY`;

export const Q_REFRESH_STATE = `
SELECT
  MAX(REFRESHED_AT)                                          AS REFRESHED_AT,
  DATEDIFF('second', MAX(REFRESHED_AT), SYSDATE())           AS AGE_SECONDS,
  MAX(N_TURNS)                                               AS N_TURNS,
  MAX(N_SPANS)                                               AS N_SPANS,
  MAX(N_SEARCH)                                              AS N_SEARCH,
  -- Which warehouse actually served this request. Reads are meant to land on
  -- the dedicated INTERACTIVE warehouse; if routing silently falls back to the
  -- connection default the dashboard still works, just 4x slower, so it is
  -- surfaced rather than assumed.
  CURRENT_WAREHOUSE()                                        AS SERVED_BY
FROM ${FLEET_SCHEMA}.FLEET_REFRESH_LOG`;

/**
 * Actual history depth, so a long window cannot imply coverage that does not
 * exist. The 365-day window is selectable but the underlying event view only
 * retains what it retains, and search request logging was enabled later still -
 * these are reported separately because they differ materially.
 */
export const Q_COVERAGE = `
SELECT
  (SELECT MIN(turn_end_ts) FROM ${FLEET_SCHEMA}.FLEET_TURNS)            AS EARLIEST_TURN_TS,
  (SELECT DATEDIFF('day', MIN(turn_end_ts), SYSDATE())
     FROM ${FLEET_SCHEMA}.FLEET_TURNS)                                  AS TURN_HISTORY_DAYS,
  (SELECT MIN(ts) FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS)           AS EARLIEST_SEARCH_TS,
  (SELECT DATEDIFF('day', MIN(ts), SYSDATE())
     FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS)                        AS SEARCH_HISTORY_DAYS`;

/* ---------------------------------------------------------------------------
   PAGE 1 - KPIs and hex fleet
   ------------------------------------------------------------------------ */

/**
 * Headline KPIs. Two distinct error rates are returned because they measure
 * different things: the root span reports status.code 200 on every turn in this
 * account, so request-level failure only surfaces via status.description, while
 * tool-level failures can occur inside an otherwise successful turn.
 */
export function qKpis(w: WindowKey, excludeEval: boolean): string {
  return `
WITH t AS (
  SELECT * FROM ${FLEET_SCHEMA}.FLEET_TURNS
  WHERE turn_end_ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
),
tok AS (
  SELECT
    SUM(total_tokens)             AS total_tokens,
    SUM(input_tokens)             AS input_tokens,
    SUM(output_tokens)            AS output_tokens,
    SUM(cache_read_input_tokens)  AS cache_read_tokens,
    SUM(cache_write_input_tokens) AS cache_write_tokens,
    SUM(plan_tokens)              AS plan_tokens
  FROM ${FLEET_SCHEMA}.FLEET_TOKENS
  WHERE ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
),
-- Cost, from the credits Snowflake metered per request.
--
-- FLEET_REQUEST_COST is at (request_id, service_type, model) grain - 445 rows for
-- 356 requests - so it is pre-aggregated to request grain in \`per_req\` BEFORE
-- touching the turn set. Joining the model grain straight to turns would multiply
-- every turn by its model count and inflate cost.
--
-- No COALESCE to 0 here on purpose: SUM over zero rows yields NULL, and NULL is
-- how the UI distinguishes "nothing metered yet" (the 60m window, since
-- ACCOUNT_USAGE lags up to an hour) from a real zero spend.
cost AS (
  SELECT
    COUNT(*)                        AS priced_requests,
    SUM(c.credits_input)            AS credits_input,
    SUM(c.credits_output)           AS credits_output,
    SUM(c.credits_cache_read)       AS credits_cache_read,
    SUM(c.credits_cache_write)      AS credits_cache_write
  FROM (
    SELECT
      request_id,
      SUM(credits_input)       AS credits_input,
      SUM(credits_output)      AS credits_output,
      SUM(credits_cache_read)  AS credits_cache_read,
      SUM(credits_cache_write) AS credits_cache_write
    FROM ${FLEET_SCHEMA}.FLEET_REQUEST_COST
    GROUP BY request_id
  ) c
  JOIN t ON t.request_id = c.request_id
)
SELECT
  (SELECT COUNT(*) FROM t)                                        AS REQUESTS,
  (SELECT COUNT(DISTINCT agent_fqn) FROM t)                       AS ACTIVE_AGENTS,
  (SELECT COUNT(*) FROM ${FLEET_SCHEMA}.FLEET_AGENT_INVENTORY)    AS TOTAL_AGENTS,
  COALESCE((SELECT total_tokens FROM tok), 0)                     AS TOKENS,
  COALESCE((SELECT input_tokens FROM tok), 0)                     AS INPUT_TOKENS,
  COALESCE((SELECT output_tokens FROM tok), 0)                    AS OUTPUT_TOKENS,
  COALESCE((SELECT cache_read_tokens FROM tok), 0)                AS CACHE_READ_TOKENS,
  COALESCE((SELECT cache_write_tokens FROM tok), 0)               AS CACHE_WRITE_TOKENS,
  COALESCE((SELECT plan_tokens FROM tok), 0)                      AS PLAN_TOKENS,
  (SELECT priced_requests     FROM cost)                          AS COST_PRICED_REQUESTS,
  (SELECT credits_input       FROM cost)                          AS COST_CREDITS_INPUT,
  (SELECT credits_output      FROM cost)                          AS COST_CREDITS_OUTPUT,
  (SELECT credits_cache_read  FROM cost)                          AS COST_CREDITS_CACHE_READ,
  (SELECT credits_cache_write FROM cost)                          AS COST_CREDITS_CACHE_WRITE,
  (SELECT COUNT_IF(is_request_error) FROM t)                      AS REQUEST_ERRORS,
  (SELECT COUNT_IF(has_tool_error) FROM t)                        AS TURNS_WITH_TOOL_ERROR,
  (SELECT COUNT_IF(is_degraded_success) FROM t)                   AS DEGRADED_SUCCESS,
  (SELECT COUNT_IF(is_flagged_slow) FROM t)                       AS FLAGGED_SLOW,
  (SELECT ROUND(APPROX_PERCENTILE(duration_ms, 0.50)) FROM t WHERE NOT is_request_error) AS P50_MS,
  (SELECT ROUND(APPROX_PERCENTILE(duration_ms, 0.95)) FROM t WHERE NOT is_request_error) AS P95_MS,
  (SELECT ROUND(APPROX_PERCENTILE(duration_ms, 0.99)) FROM t WHERE NOT is_request_error) AS P99_MS,
  (SELECT COUNT_IF(is_eval_run) FROM ${FLEET_SCHEMA}.FLEET_TURNS
     WHERE turn_end_ts >= ${since(w)})                            AS EVAL_TURNS_IN_WINDOW`;
}

/**
 * Copy-pasteable SQL for the Agent Requests KPI, shown in that card's info
 * popover so an operator can verify the number rather than trust it.
 *
 * Emits bare SQL - no header or explanatory comments. The popover already
 * carries the prose definition above this block, and comments inside the
 * snippet made it read as documentation rather than something you run.
 *
 * Built from the same `since()` helper, `FLEET_SCHEMA` constant and eval
 * predicate as the real query in `qKpis()`, so the SQL an operator reads cannot
 * drift from the SQL that produced the figure on screen. Hardcoding this string
 * in the page would have let the two diverge silently on the next window or
 * schema change. `qKpis` computes eighteen metrics in one round trip; this
 * isolates the request count and is otherwise semantically identical.
 *
 * COUNT(*) is deliberate, not COUNT(DISTINCT request_id): the grain is one row
 * per turn (one root AgentV2RequestResponseInfo span), and a turn that fails
 * before a request id is assigned has none - those are exactly the errors worth
 * counting, and a DISTINCT on request_id would silently drop them.
 *
 * Takes a raw string and narrows with `isWindowKey`, matching the fallback in
 * app/api/fleet/route.ts, so an unrecognised window shows the SQL that the
 * server would actually have run for it.
 *
 * `agentFqn` scopes the snippet to one agent for the /agents page. These strings
 * are DISPLAY ONLY - the app never executes them, the real queries use binds - so
 * a literal predicate is correct here and keeps the snippet copy-pasteable.
 */
export function explainRequests(w: string, excludeEval: boolean, agentFqn?: string | null): string {
  const k: WindowKey = isWindowKey(w) ? w : "24h";
  return `SELECT COUNT(*) AS REQUESTS
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE turn_end_ts >= ${since(k)}${agentFqn ? `\n  AND agent_fqn = '${agentFqn}'` : ""}${excludeEval ? "\n  AND NOT is_eval_run" : ""};`;
}

/**
 * Copy-pasteable SQL for the Active Agents KPI. Same drift-proofing and same
 * narrowing behaviour as `explainRequests` above.
 *
 * Returns BOTH figures because the tile renders "3 / 10" and the two halves
 * have deliberately different scopes - showing only the numerator would imply
 * the denominator was windowed too. It is not: FLEET_AGENT_INVENTORY is built
 * from SHOW AGENTS IN ACCOUNT, so an agent that has never served a request
 * still counts toward the total.
 *
 * Kept in the same scalar-subquery shape as `qKpis()` rather than reduced to a
 * tidier join, so the snippet reads as the query that actually ran.
 */
export function explainActiveAgents(w: string, excludeEval: boolean): string {
  const k: WindowKey = isWindowKey(w) ? w : "24h";
  return `SELECT
  (SELECT COUNT(DISTINCT agent_fqn)
     FROM ${FLEET_SCHEMA}.FLEET_TURNS
     WHERE turn_end_ts >= ${since(k)}${excludeEval ? "\n       AND NOT is_eval_run" : ""}
  ) AS ACTIVE_AGENTS,
  (SELECT COUNT(*)
     FROM ${FLEET_SCHEMA}.FLEET_AGENT_INVENTORY
  ) AS TOTAL_AGENTS;`;
}

/**
 * Copy-pasteable SQL for the Agent Cost KPI. Same drift-proofing and narrowing as
 * the two builders above.
 *
 * Shows the credit-to-dollar conversion explicitly, because the dollar figure is
 * the one number on this page that depends on a configured rate rather than purely
 * on measured data. `usdRate` is passed in from FLEET_CONFIG so the snippet always
 * reflects the rate that produced the value on screen.
 *
 * Pre-aggregates to request grain in a subquery before joining turns, mirroring
 * `qKpis`. Written that way rather than as a flat join because the flat version
 * silently multiplies each turn by its model count.
 */
export function explainCost(
  w: string,
  excludeEval: boolean,
  usdRate: number,
  agentFqn?: string | null,
): string {
  const k: WindowKey = isWindowKey(w) ? w : "24h";
  const rate = Number.isFinite(usdRate) && usdRate > 0 ? usdRate : 2.0;
  return `SELECT
  ROUND(${rate} * SUM(c.credits), 2)                AS COST_USD,
  ROUND(SUM(c.credits), 4)                          AS AI_CREDITS
FROM (
  SELECT
    request_id,
    SUM(credits_input + credits_output
        + credits_cache_read + credits_cache_write) AS credits
  FROM ${FLEET_SCHEMA}.FLEET_REQUEST_COST
  GROUP BY request_id
) c
JOIN ${FLEET_SCHEMA}.FLEET_TURNS t ON t.request_id = c.request_id
WHERE t.turn_end_ts >= ${since(k)}${agentFqn ? `\n  AND t.agent_fqn = '${agentFqn}'` : ""}${excludeEval ? "\n  AND NOT t.is_eval_run" : ""};`;
}

/**
 * Copy-pasteable SQL for the Turns per Thread KPI on the /agents page.
 *
 * The numerator is COUNT_IF(thread_id IS NOT NULL), NOT COUNT(*). `thread_id` is
 * not fully populated - 8 of 250 non-eval turns have none - and COUNT(DISTINCT)
 * skips NULLs while COUNT(*) does not, so COUNT(*) / COUNT(DISTINCT thread_id)
 * credits threadless turns to threads that never held them. Verified on this
 * account: the busiest agent reads 3.77 that way against 3.50 correctly, and
 * BTQ_OPS reads 3.00 against 2.00.
 *
 * THREADLESS_TURNS is selected so the excluded turns are visible in the snippet
 * rather than looking like they were forgotten.
 */
export function explainTurnsPerThread(
  w: string,
  excludeEval: boolean,
  agentFqn?: string | null,
): string {
  const k: WindowKey = isWindowKey(w) ? w : "24h";
  return `SELECT
  COUNT(DISTINCT thread_id)                 AS THREADS,
  COUNT_IF(thread_id IS NOT NULL)           AS TURNS_IN_THREADS,
  COUNT_IF(thread_id IS NULL)               AS THREADLESS_TURNS,
  ROUND(COUNT_IF(thread_id IS NOT NULL)
        / NULLIF(COUNT(DISTINCT thread_id), 0), 2) AS TURNS_PER_THREAD
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE turn_end_ts >= ${since(k)}${agentFqn ? `\n  AND agent_fqn = '${agentFqn}'` : ""}${excludeEval ? "\n  AND NOT is_eval_run" : ""};`;
}

/**
 * Copy-pasteable SQL for the Error Rate KPI. Same drift-proofing and narrowing as
 * the builders above.
 *
 * Returns BOTH rates plus their raw numerators, because the tile shows two
 * percentages over a shared denominator and they measure different things. In this
 * account the root span reports status.code 200 on EVERY turn, so request-level
 * failure surfaces only through status.description - which is what
 * `is_request_error` encodes. A tool can fail inside an otherwise successful turn,
 * so `has_tool_error` is tracked separately and the two are never blended.
 *
 * `is_degraded_success` is included because the tile's detail line reports it: a
 * turn that returned HTTP-success with an empty or "Unable to respond" payload.
 */
export function explainErrorRates(w: string, excludeEval: boolean, agentFqn?: string | null): string {
  const k: WindowKey = isWindowKey(w) ? w : "24h";
  return `SELECT
  COUNT(*)                            AS REQUESTS,
  COUNT_IF(is_request_error)          AS REQUEST_ERRORS,
  COUNT_IF(has_tool_error)            AS TURNS_WITH_TOOL_ERROR,
  COUNT_IF(is_degraded_success)       AS DEGRADED_SUCCESS,
  ROUND(100 * COUNT_IF(is_request_error)
            / NULLIF(COUNT(*), 0), 1) AS REQUEST_ERROR_PCT,
  ROUND(100 * COUNT_IF(has_tool_error)
            / NULLIF(COUNT(*), 0), 1) AS TOOL_ERROR_PCT
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE turn_end_ts >= ${since(k)}${agentFqn ? `\n  AND agent_fqn = '${agentFqn}'` : ""}${excludeEval ? "\n  AND NOT is_eval_run" : ""};`;
}

/**
 * Hex fleet state. Thresholds come from FLEET_CONFIG rather than being
 * hardcoded, and RED takes precedence over GREEN/YELLOW.
 *
 * Tile order is triage order, not volume order: CRITICAL first, then NOMINAL,
 * IDLE, OFF, and within each band the most recently active agent leads. The
 * state is computed in a CTE so the outer ORDER BY can rank on it directly.
 * turns_total is still selected and still rendered inside each tile, so
 * relative activity stays visible without driving position.
 */
export function qHexFleet(
  greenMinutes: number,
  yellowHours: number,
  redHours: number,
  redIncludesTool: boolean,
): string {
  const g = Number.isFinite(greenMinutes) ? Math.trunc(greenMinutes) : 60;
  const y = Number.isFinite(yellowHours) ? Math.trunc(yellowHours) : 24;
  const r = Number.isFinite(redHours) ? Math.trunc(redHours) : 24;
  const errTs = redIncludesTool
    ? `GREATEST(COALESCE(last_request_error_ts, '1970-01-01'::TIMESTAMP_NTZ),
                COALESCE(last_tool_error_ts,    '1970-01-01'::TIMESTAMP_NTZ))`
    : `COALESCE(last_request_error_ts, '1970-01-01'::TIMESTAMP_NTZ)`;

  return `
WITH scored AS (
  SELECT
    agent_fqn                AS AGENT_FQN,
    agent_database           AS AGENT_DATABASE,
    agent_schema             AS AGENT_SCHEMA,
    agent_name               AS AGENT_NAME,
    display_name             AS DISPLAY_NAME,
    profile_color            AS PROFILE_COLOR,
    agent_owner              AS AGENT_OWNER,
    turns_total              AS TURNS_TOTAL,
    distinct_users           AS DISTINCT_USERS,
    last_turn_ts             AS LAST_TURN_TS,
    last_success_ts          AS LAST_SUCCESS_TS,
    last_request_error_ts    AS LAST_REQUEST_ERROR_TS,
    last_tool_error_ts       AS LAST_TOOL_ERROR_TS,
    DATEDIFF('minute', last_turn_ts, SYSDATE()) AS MINUTES_SINCE_LAST_TURN,
    CASE
      WHEN ${errTs} >= DATEADD('hour',   -${r}, SYSDATE()) THEN 'CRITICAL'
      WHEN last_success_ts >= DATEADD('minute', -${g}, SYSDATE()) THEN 'NOMINAL'
      WHEN last_success_ts >= DATEADD('hour',   -${y}, SYSDATE()) THEN 'IDLE'
      ELSE 'OFF'
    END AS HEX_STATE
  FROM ${FLEET_SCHEMA}.FLEET_AGENT_INVENTORY
)
SELECT * FROM scored
ORDER BY
  CASE HEX_STATE
    WHEN 'CRITICAL' THEN 0
    WHEN 'NOMINAL'  THEN 1
    WHEN 'IDLE'     THEN 2
    ELSE 3
  END,
  LAST_TURN_TS DESC NULLS LAST,
  DISPLAY_NAME`;
}

/** Requests-per-bucket trend for the sparkline under the KPI row. */
export function qRequestTrend(w: WindowKey, excludeEval: boolean): string {
  const b = bucket(w);
  return `
SELECT
  DATE_TRUNC('${b}', turn_end_ts)  AS TS,
  COUNT(*)                         AS REQUESTS,
  COUNT_IF(is_request_error)       AS REQUEST_ERRORS,
  COUNT_IF(has_tool_error)         AS TOOL_ERRORS
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE turn_end_ts >= ${since(w)}
  ${excludeEval ? "AND NOT is_eval_run" : ""}
GROUP BY 1 ORDER BY 1`;
}

/* ---------------------------------------------------------------------------
   PAGE 2 - fleet trends, layered limits, saturation
   ------------------------------------------------------------------------ */

export function qTopUsers(w: WindowKey, excludeEval: boolean): string {
  return `
SELECT
  COALESCE(user_name, '(unattributed)') AS USER_NAME,
  COUNT(*)                              AS REQUESTS,
  COUNT_IF(is_request_error)            AS ERRORS,
  ROUND(APPROX_PERCENTILE(duration_ms, 0.95)) AS P95_MS
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE turn_end_ts >= ${since(w)}
  ${excludeEval ? "AND NOT is_eval_run" : ""}
GROUP BY 1 ORDER BY REQUESTS DESC LIMIT 12`;
}

export function qTopRoles(w: WindowKey, excludeEval: boolean): string {
  return `
SELECT
  COALESCE(role_name, '(unattributed)') AS ROLE_NAME,
  COUNT(*)                              AS REQUESTS,
  COUNT_IF(is_request_error)            AS ERRORS,
  COUNT(DISTINCT agent_fqn)             AS AGENTS_USED
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE turn_end_ts >= ${since(w)}
  ${excludeEval ? "AND NOT is_eval_run" : ""}
GROUP BY 1 ORDER BY REQUESTS DESC LIMIT 12`;
}

/**
 * Error taxonomy. Buckets are derived from the actual failure descriptions
 * present in this account, and are keyed on the stage that DETECTED the
 * failure rather than a speculative root cause.
 */
export function qErrorTaxonomy(w: WindowKey, excludeEval: boolean): string {
  return `
WITH e AS (
  SELECT
    agent_fqn,
    end_ts,
    span_category,
    COALESCE(tool_type, 'planning')     AS failing_stage,
    COALESCE(tool_status_description, planning_status_description, 'unspecified') AS descr
  FROM ${FLEET_SCHEMA}.FLEET_SPANS
  WHERE end_ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
    AND (tool_status = 'ERROR' OR planning_status = 'ERROR')
)
SELECT
  CASE
    WHEN descr ILIKE '%429%' OR descr ILIKE '%throttl%'          THEN 'Rate limit / throttle'
    WHEN descr ILIKE '%timeout%' OR descr ILIKE '%408%'          THEN 'Timeout'
    WHEN descr ILIKE '%not authorized%' OR descr ILIKE '%privilege%'
         OR descr ILIKE '%must have%'                            THEN 'Permission'
    WHEN descr ILIKE '%double counting%' OR descr ILIKE '%join%valid%'
         OR descr ILIKE '%physical table%'                       THEN 'Semantic / join validation'
    WHEN descr ILIKE '%invalid identifier%'
         OR descr ILIKE '%SQL compilation%'                      THEN 'SQL compilation'
    WHEN descr ILIKE '%vega%' OR descr ILIKE '%chart%'           THEN 'Chart spec'
    WHEN descr ILIKE '%warehouse%'                               THEN 'Warehouse not specified'
    WHEN descr ILIKE '%error parsing your response%'             THEN 'Model output format'
    WHEN descr ILIKE '%filter%'                                  THEN 'Search filter'
    ELSE 'Other'
  END                        AS ERROR_CLASS,
  failing_stage              AS FAILING_STAGE,
  COUNT(*)                   AS N,
  COUNT(DISTINCT agent_fqn)  AS AGENTS,
  MAX(end_ts)                AS LAST_SEEN,
  ANY_VALUE(descr)           AS SAMPLE_DESCRIPTION
FROM e
GROUP BY 1, 2
ORDER BY N DESC`;
}

/**
 * LLM saturation. Per-minute buckets, MAX for the peak, and percentiles of the
 * per-minute series so a single burst can be told apart from structural load.
 * Joined FROM the limits table so models with a limit but no traffic still
 * render at 0% rather than disappearing.
 *
 * Note the denominator: a per-model TPM/RPM quota is consumed by ALL inference
 * in the account, so agent usage is reported as a share of the ceiling, not as
 * the whole story.
 */
export function qModelSaturation(w: WindowKey, excludeEval: boolean): string {
  return `
WITH per_min AS (
  SELECT model_name, ts_minute,
         COUNT(DISTINCT trace_id) AS rpm,
         SUM(total_tokens)        AS tpm
  FROM ${FLEET_SCHEMA}.FLEET_TOKENS
  WHERE ts >= ${since(w)}
    AND model_name IS NOT NULL
    ${excludeEval ? "AND NOT is_eval_run" : ""}
  GROUP BY 1, 2
),
agg AS (
  SELECT model_name,
         MAX(rpm)                            AS peak_rpm,
         MAX(tpm)                            AS peak_tpm,
         ROUND(APPROX_PERCENTILE(tpm, 0.50)) AS p50_tpm,
         ROUND(APPROX_PERCENTILE(tpm, 0.99)) AS p99_tpm,
         SUM(tpm)                            AS total_tokens,
         COUNT(*)                            AS active_minutes
  FROM per_min GROUP BY 1
),
lim AS (
  SELECT LIMIT_KEY AS model_name,
         MAX(IFF(METRIC='TPM', LIMIT_VALUE, NULL)) AS tpm_limit,
         MAX(IFF(METRIC='RPM', LIMIT_VALUE, NULL)) AS rpm_limit,
         ANY_VALUE(SOURCE)                          AS source
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'MODEL'
  GROUP BY 1
)
SELECT
  l.model_name                                            AS MODEL_NAME,
  l.tpm_limit                                             AS TPM_LIMIT,
  l.rpm_limit                                             AS RPM_LIMIT,
  l.source                                                AS SOURCE,
  COALESCE(a.peak_tpm, 0)                                 AS PEAK_TPM,
  COALESCE(a.peak_rpm, 0)                                 AS PEAK_RPM,
  COALESCE(a.p50_tpm, 0)                                  AS P50_TPM,
  COALESCE(a.p99_tpm, 0)                                  AS P99_TPM,
  COALESCE(a.total_tokens, 0)                             AS TOTAL_TOKENS,
  COALESCE(a.active_minutes, 0)                           AS ACTIVE_MINUTES,
  ROUND(100.0 * COALESCE(a.peak_tpm, 0) / NULLIF(l.tpm_limit, 0), 2) AS PCT_TPM_USED,
  ROUND(100.0 * COALESCE(a.peak_rpm, 0) / NULLIF(l.rpm_limit, 0), 2) AS PCT_RPM_USED
FROM lim l
LEFT JOIN agg a ON a.model_name = l.model_name
WHERE COALESCE(a.total_tokens, 0) > 0
ORDER BY PCT_TPM_USED DESC NULLS LAST, TOTAL_TOKENS DESC`;
}

/**
 * Agent API saturation against the 500 RPM account cap. This is a separate,
 * simultaneously-applicable ceiling: an agent request is throttled if EITHER
 * this cap or the orchestration model's per-model limit is breached.
 */
export function qAgentApiSaturation(w: WindowKey, excludeEval: boolean): string {
  return `
WITH per_min AS (
  SELECT DATE_TRUNC('minute', turn_end_ts) AS ts_minute, COUNT(*) AS rpm
  FROM ${FLEET_SCHEMA}.FLEET_TURNS
  WHERE turn_end_ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
  GROUP BY 1
),
lim AS (
  SELECT MAX(LIMIT_VALUE) AS rpm_limit, ANY_VALUE(SOURCE) AS source, ANY_VALUE(NOTE) AS note
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'AGENT_API' AND METRIC = 'RPM'
)
SELECT
  l.rpm_limit                                        AS RPM_LIMIT,
  l.source                                           AS SOURCE,
  l.note                                             AS NOTE,
  COALESCE(MAX(p.rpm), 0)                            AS PEAK_RPM,
  COALESCE(ROUND(APPROX_PERCENTILE(p.rpm, 0.50)), 0) AS P50_RPM,
  COALESCE(ROUND(APPROX_PERCENTILE(p.rpm, 0.99)), 0) AS P99_RPM,
  COALESCE(COUNT(p.ts_minute), 0)                    AS ACTIVE_MINUTES,
  ROUND(100.0 * COALESCE(MAX(p.rpm), 0) / NULLIF(l.rpm_limit, 0), 2) AS PCT_RPM_USED
FROM lim l LEFT JOIN per_min p ON TRUE
GROUP BY l.rpm_limit, l.source, l.note`;
}

/**
 * Cortex Search saturation. Buckets per SECOND because the limits are per
 * second. Per-service and account-wide are computed separately: the account
 * figure sums across services WITHIN each second before taking the max.
 */
export function qSearchSaturation(w: WindowKey): string {
  return `
WITH req AS (
  SELECT service_fqn,
         COUNT(*)               AS total_req,
         COUNT_IF(is_throttled) AS n_429,
         ROUND(100.0 * COUNT_IF(is_throttled) / NULLIF(COUNT(*), 0), 1) AS pct_429,
         ROUND(APPROX_PERCENTILE(IFF(is_success,   response_time_ms, NULL), 0.50)) AS p50_ok_ms,
         ROUND(APPROX_PERCENTILE(IFF(is_success,   response_time_ms, NULL), 0.95)) AS p95_ok_ms,
         ROUND(APPROX_PERCENTILE(IFF(is_throttled, response_time_ms, NULL), 0.95)) AS p95_429_ms,
         MAX(ts) AS last_seen
  FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
  WHERE ts >= ${since(w)}
  GROUP BY 1
),
per_sec AS (
  SELECT service_fqn, ts_second, COUNT(*) AS qps
  FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
  WHERE ts >= ${since(w)}
  GROUP BY 1, 2
),
sec AS (
  SELECT service_fqn,
         MAX(qps)                            AS peak_qps,
         ROUND(APPROX_PERCENTILE(qps, 0.50)) AS p50_qps,
         ROUND(APPROX_PERCENTILE(qps, 0.99)) AS p99_qps
  FROM per_sec GROUP BY 1
),
lim AS (
  SELECT MAX(IFF(LIMIT_SCOPE='SEARCH_SERVICE', LIMIT_VALUE, NULL)) AS svc_qps,
         MAX(IFF(LIMIT_SCOPE='SEARCH_ACCOUNT', LIMIT_VALUE, NULL)) AS acct_qps
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS WHERE METRIC = 'QPS'
)
SELECT
  r.service_fqn                                     AS SERVICE_FQN,
  r.total_req                                        AS TOTAL_REQ,
  r.n_429                                            AS N_429,
  r.pct_429                                          AS PCT_429,
  r.p50_ok_ms                                        AS P50_OK_MS,
  r.p95_ok_ms                                        AS P95_OK_MS,
  r.p95_429_ms                                       AS P95_429_MS,
  r.last_seen                                        AS LAST_SEEN,
  s.peak_qps                                         AS PEAK_QPS,
  s.p50_qps                                          AS P50_QPS,
  s.p99_qps                                          AS P99_QPS,
  l.svc_qps                                          AS SVC_QPS_LIMIT,
  ROUND(100.0 * s.peak_qps / NULLIF(l.svc_qps, 0), 1) AS PCT_OF_SVC_LIMIT
FROM req r
JOIN sec s ON s.service_fqn = r.service_fqn
CROSS JOIN lim l
ORDER BY PCT_OF_SVC_LIMIT DESC NULLS LAST`;
}

/** Account-wide search QPS: sum within each second, THEN take the max. */
export function qSearchAccountSaturation(w: WindowKey): string {
  return `
WITH per_sec AS (
  SELECT ts_second, COUNT(*) AS qps
  FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
  WHERE ts >= ${since(w)}
  GROUP BY 1
),
lim AS (
  SELECT MAX(LIMIT_VALUE) AS acct_qps, ANY_VALUE(SOURCE) AS source
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'SEARCH_ACCOUNT' AND METRIC = 'QPS'
)
SELECT
  l.acct_qps                                                  AS ACCT_QPS_LIMIT,
  l.source                                                    AS SOURCE,
  COALESCE(MAX(p.qps), 0)                                     AS PEAK_QPS,
  COALESCE(ROUND(APPROX_PERCENTILE(p.qps, 0.50)), 0)          AS P50_QPS,
  COALESCE(ROUND(APPROX_PERCENTILE(p.qps, 0.99)), 0)          AS P99_QPS,
  ROUND(100.0 * COALESCE(MAX(p.qps), 0) / NULLIF(l.acct_qps, 0), 1) AS PCT_OF_ACCT_LIMIT
FROM lim l LEFT JOIN per_sec p ON TRUE
GROUP BY l.acct_qps, l.source`;
}

/** Which search services have request logging on. Honest coverage reporting. */
export const Q_SEARCH_COVERAGE = `
SELECT
  service_fqn AS SERVICE_FQN,
  COUNT(*)    AS TOTAL_REQ,
  MAX(ts)     AS LAST_SEEN
FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
GROUP BY 1 ORDER BY 2 DESC`;

/* ---------------------------------------------------------------------------
   PAGE 2 - saturation over time
   ---------------------------------------------------------------------------

   Every query in this section answers "WHEN did a ceiling get close?", which
   needs TWO levels of bucketing:

     inner bucket = the limit's own granularity  (MINUTE for RPM/TPM, SECOND for QPS)
     outer bucket = the display granularity      (bucket(w): minute/hour/day/week)
     roll-up      = MAX(inner) within each outer

   Collapsing those two levels is the fastest way to make these charts lie. The
   roll-up MUST be MAX and never AVG: day-bucketing the real incident in this
   account with an average turns a 409 QPS peak into ~7. Verified against live
   data - the per-service trend below reproduces 409 QPS / 2045% on 2026-08-31,
   which is exactly the figure the binding constraint reports at 30d.

   qSearchThrottleTrend is the deliberate exception: a 429 RATE is a ratio over
   requests, not a ceiling check, so it buckets request-grain straight to the
   display bucket with no MAX.
   ------------------------------------------------------------------------ */

/** Agent API RPM per display bucket, measured per minute. */
export function qAgentApiTrend(w: WindowKey, excludeEval: boolean): string {
  const b = bucket(w);
  return `
WITH per_min AS (
  SELECT DATE_TRUNC('minute', turn_end_ts) AS ts_minute, COUNT(*) AS rpm
  FROM ${FLEET_SCHEMA}.FLEET_TURNS
  WHERE turn_end_ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
  GROUP BY 1
),
per_bucket AS (
  SELECT DATE_TRUNC('${b}', ts_minute)       AS ts,
         MAX(rpm)                            AS peak_rpm,
         ROUND(APPROX_PERCENTILE(rpm, 0.50)) AS p50_rpm,
         COUNT(*)                            AS active_minutes
  FROM per_min GROUP BY 1
),
lim AS (
  SELECT MAX(LIMIT_VALUE) AS rpm_limit, ANY_VALUE(SOURCE) AS source
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'AGENT_API' AND METRIC = 'RPM'
)
SELECT
  b.ts                                                  AS TS,
  b.peak_rpm                                            AS PEAK_RPM,
  b.p50_rpm                                             AS P50_RPM,
  b.active_minutes                                      AS ACTIVE_MINUTES,
  l.rpm_limit                                           AS LIMIT_VALUE,
  l.source                                              AS SOURCE,
  ROUND(100.0 * b.peak_rpm / NULLIF(l.rpm_limit, 0), 2) AS PCT_OF_LIMIT
FROM per_bucket b CROSS JOIN lim l
ORDER BY b.ts`;
}

/**
 * Per-model TPM and RPM per display bucket, measured per minute.
 *
 * Returns peak RPM alongside peak TPM because both are real ceilings - a model
 * can be near its request-per-minute cap with plenty of token headroom.
 */
export function qModelSaturationTrend(w: WindowKey, excludeEval: boolean): string {
  const b = bucket(w);
  return `
WITH per_min AS (
  SELECT model_name, ts_minute,
         SUM(total_tokens)        AS tpm,
         COUNT(DISTINCT trace_id) AS rpm
  FROM ${FLEET_SCHEMA}.FLEET_TOKENS
  WHERE ts >= ${since(w)}
    AND model_name IS NOT NULL
    ${excludeEval ? "AND NOT is_eval_run" : ""}
  GROUP BY 1, 2
),
per_bucket AS (
  SELECT model_name,
         DATE_TRUNC('${b}', ts_minute)       AS ts,
         MAX(tpm)                            AS peak_tpm,
         MAX(rpm)                            AS peak_rpm,
         ROUND(APPROX_PERCENTILE(tpm, 0.50)) AS p50_tpm,
         COUNT(*)                            AS active_minutes
  FROM per_min GROUP BY 1, 2
),
lim AS (
  SELECT LIMIT_KEY AS model_name,
         MAX(IFF(METRIC = 'TPM', LIMIT_VALUE, NULL)) AS tpm_limit,
         MAX(IFF(METRIC = 'RPM', LIMIT_VALUE, NULL)) AS rpm_limit
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'MODEL'
  GROUP BY 1
)
SELECT
  b.model_name                                            AS MODEL_NAME,
  b.ts                                                    AS TS,
  b.peak_tpm                                              AS PEAK_TPM,
  b.peak_rpm                                              AS PEAK_RPM,
  b.p50_tpm                                               AS P50_TPM,
  b.active_minutes                                        AS ACTIVE_MINUTES,
  l.tpm_limit                                             AS TPM_LIMIT,
  l.rpm_limit                                             AS RPM_LIMIT,
  ROUND(100.0 * b.peak_tpm / NULLIF(l.tpm_limit, 0), 2)   AS PCT_TPM,
  ROUND(100.0 * b.peak_rpm / NULLIF(l.rpm_limit, 0), 2)   AS PCT_RPM
FROM per_bucket b
JOIN lim l ON l.model_name = b.model_name
ORDER BY b.model_name, b.ts`;
}

/** Per-service search QPS per display bucket, measured per SECOND. */
export function qSearchQpsTrend(w: WindowKey): string {
  const b = bucket(w);
  return `
WITH per_sec AS (
  SELECT service_fqn, ts_second, COUNT(*) AS qps
  FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
  WHERE ts >= ${since(w)}
  GROUP BY 1, 2
),
per_bucket AS (
  SELECT service_fqn,
         DATE_TRUNC('${b}', ts_second)       AS ts,
         MAX(qps)                            AS peak_qps,
         ROUND(APPROX_PERCENTILE(qps, 0.50)) AS p50_qps,
         COUNT(*)                            AS active_seconds
  FROM per_sec GROUP BY 1, 2
),
lim AS (
  SELECT MAX(LIMIT_VALUE) AS svc_qps
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'SEARCH_SERVICE' AND METRIC = 'QPS'
)
SELECT
  b.service_fqn                                         AS SERVICE_FQN,
  b.ts                                                  AS TS,
  b.peak_qps                                            AS PEAK_QPS,
  b.p50_qps                                             AS P50_QPS,
  b.active_seconds                                      AS ACTIVE_SECONDS,
  l.svc_qps                                             AS LIMIT_VALUE,
  ROUND(100.0 * b.peak_qps / NULLIF(l.svc_qps, 0), 1)   AS PCT_OF_LIMIT
FROM per_bucket b CROSS JOIN lim l
ORDER BY b.service_fqn, b.ts`;
}

/**
 * Account-wide search QPS per display bucket.
 *
 * Counting every row within a second IS the sum across services, which is the
 * correct order of operations: max-per-service-then-sum overstates the peak,
 * because different services peak in different seconds.
 */
export function qSearchAccountQpsTrend(w: WindowKey): string {
  const b = bucket(w);
  return `
WITH per_sec AS (
  SELECT ts_second, COUNT(*) AS qps
  FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
  WHERE ts >= ${since(w)}
  GROUP BY 1
),
per_bucket AS (
  SELECT DATE_TRUNC('${b}', ts_second)       AS ts,
         MAX(qps)                            AS peak_qps,
         ROUND(APPROX_PERCENTILE(qps, 0.50)) AS p50_qps,
         COUNT(*)                            AS active_seconds
  FROM per_sec GROUP BY 1
),
lim AS (
  SELECT MAX(LIMIT_VALUE) AS acct_qps, ANY_VALUE(SOURCE) AS source
  FROM ${FLEET_SCHEMA}.FLEET_RATE_LIMITS
  WHERE LIMIT_SCOPE = 'SEARCH_ACCOUNT' AND METRIC = 'QPS'
)
SELECT
  b.ts                                                  AS TS,
  b.peak_qps                                            AS PEAK_QPS,
  b.p50_qps                                             AS P50_QPS,
  b.active_seconds                                      AS ACTIVE_SECONDS,
  l.acct_qps                                            AS LIMIT_VALUE,
  l.source                                              AS SOURCE,
  ROUND(100.0 * b.peak_qps / NULLIF(l.acct_qps, 0), 1)  AS PCT_OF_LIMIT
FROM per_bucket b CROSS JOIN lim l
ORDER BY b.ts`;
}

/**
 * Throttling over time. NOT a ceiling check, so no MAX roll-up - a 429 rate is
 * a ratio over requests and buckets request-grain directly.
 *
 * Latency is split by status and the mean is never reported: in this account
 * throttled requests were ~2x FASTER than successful ones (a 429 short-circuits),
 * so a blended average IMPROVES while most requests are failing.
 */
export function qSearchThrottleTrend(w: WindowKey): string {
  const b = bucket(w);
  return `
SELECT
  DATE_TRUNC('${b}', ts)                                                    AS TS,
  COUNT(*)                                                                  AS TOTAL_REQ,
  COUNT_IF(is_throttled)                                                    AS N_429,
  ROUND(100.0 * COUNT_IF(is_throttled) / NULLIF(COUNT(*), 0), 1)            AS PCT_429,
  ROUND(APPROX_PERCENTILE(IFF(is_success,   response_time_ms, NULL), 0.95)) AS P95_OK_MS,
  ROUND(APPROX_PERCENTILE(IFF(is_throttled, response_time_ms, NULL), 0.95)) AS P95_429_MS
FROM ${FLEET_SCHEMA}.FLEET_SEARCH_REQUESTS
WHERE ts >= ${since(w)}
GROUP BY 1
ORDER BY 1`;
}

/* ---------------------------------------------------------------------------
   PAGE 3 - agent deep dive
   ------------------------------------------------------------------------ */

export function qAgentTrend(w: WindowKey, excludeEval: boolean): string {
  const b = bucket(w);
  return `
SELECT
  DATE_TRUNC('${b}', turn_end_ts) AS TS,
  COUNT(*)                        AS REQUESTS,
  COUNT_IF(is_request_error)      AS REQUEST_ERRORS,
  COUNT_IF(has_tool_error)        AS TOOL_ERRORS,
  ROUND(APPROX_PERCENTILE(duration_ms, 0.50)) AS P50_MS,
  ROUND(APPROX_PERCENTILE(duration_ms, 0.95)) AS P95_MS
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE agent_fqn = ? AND turn_end_ts >= ${since(w)}
  ${excludeEval ? "AND NOT is_eval_run" : ""}
GROUP BY 1 ORDER BY 1`;
}

/**
 * Token usage per bucket.
 *
 * Verified against all 1,349 LLM spans in this account:
 *   total = input + output                        (1349/1349 spans)
 *   cache_read + cache_write <= input             (1349/1349 spans)
 *   plan_tokens is NOT additive into total, and exceeds output on most spans
 *
 * So the five reported categories cannot be stacked flat - doing so sums to
 * 71.7M against a real total of 35.3M. FRESH_INPUT is derived here so the
 * stackable set (cache_read + cache_write + fresh_input + output) reconciles
 * exactly to total, and plan is returned for separate, non-stacked display.
 */
export function qAgentTokens(w: WindowKey, excludeEval: boolean): string {
  const b = bucket(w);
  return `
SELECT
  DATE_TRUNC('${b}', ts)             AS TS,
  SUM(cache_read_input_tokens)       AS CACHE_READ_INPUT_TOKENS,
  SUM(cache_write_input_tokens)      AS CACHE_WRITE_INPUT_TOKENS,
  SUM(input_tokens)                  AS INPUT_TOKENS,
  SUM(GREATEST(input_tokens - cache_read_input_tokens - cache_write_input_tokens, 0))
                                     AS FRESH_INPUT_TOKENS,
  SUM(output_tokens)                 AS OUTPUT_TOKENS,
  SUM(plan_tokens)                   AS PLAN_TOKENS,
  SUM(total_tokens)                  AS TOTAL_TOKENS
FROM ${FLEET_SCHEMA}.FLEET_TOKENS
WHERE agent_fqn = ? AND ts >= ${since(w)}
  ${excludeEval ? "AND NOT is_eval_run" : ""}
GROUP BY 1 ORDER BY 1`;
}

/** Resource usage frequency: semantic views, search services, skills, tools. */
export function qAgentResources(w: WindowKey, excludeEval: boolean): string {
  return `
WITH s AS (
  SELECT * FROM ${FLEET_SCHEMA}.FLEET_SPANS
  WHERE agent_fqn = ? AND end_ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
)
SELECT 'Semantic View' AS KIND, semantic_view AS NAME, COUNT(*) AS N,
       ROUND(APPROX_PERCENTILE(latency_ms, 0.95)) AS P95_MS,
       COUNT_IF(is_tool_error) AS ERRORS
FROM s WHERE semantic_view IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'Cortex Search', cortex_search, COUNT(*),
       ROUND(APPROX_PERCENTILE(latency_ms, 0.95)), COUNT_IF(is_tool_error)
FROM s WHERE cortex_search IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'Cortex Analyst', cortex_analyst, COUNT(*),
       ROUND(APPROX_PERCENTILE(latency_ms, 0.95)), COUNT_IF(is_tool_error)
FROM s WHERE cortex_analyst IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'Skill', skill_name, COUNT(*),
       ROUND(APPROX_PERCENTILE(latency_ms, 0.95)), COUNT_IF(is_tool_error)
FROM s WHERE skill_name IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'Chart Tool', chart_tool, COUNT(*),
       ROUND(APPROX_PERCENTILE(latency_ms, 0.95)), COUNT_IF(is_tool_error)
FROM s WHERE chart_tool IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'Other Tool', tool_name, COUNT(*),
       ROUND(APPROX_PERCENTILE(latency_ms, 0.95)), COUNT_IF(is_tool_error)
FROM s WHERE tool_name IS NOT NULL GROUP BY 1,2
ORDER BY N DESC`;
}

/**
 * Latency decomposition by tail cohort. Percentiles do not sum, so a stacked
 * p95-per-span chart would show a total no request ever experienced. Instead
 * the p95 cohort is selected by TOTAL turn duration, and mean self-time per
 * span category within that cohort is compared against the p50 cohort.
 */
export function qLatencyCohorts(w: WindowKey, excludeEval: boolean): string {
  return `
WITH turns AS (
  SELECT trace_id, duration_ms
  FROM ${FLEET_SCHEMA}.FLEET_TURNS
  WHERE agent_fqn = ? AND turn_end_ts >= ${since(w)}
    AND NOT is_request_error
    ${excludeEval ? "AND NOT is_eval_run" : ""}
),
thresholds AS (
  SELECT APPROX_PERCENTILE(duration_ms, 0.95) AS p95,
         APPROX_PERCENTILE(duration_ms, 0.45) AS p45,
         APPROX_PERCENTILE(duration_ms, 0.55) AS p55
  FROM turns
),
cohort AS (
  SELECT t.trace_id,
         CASE WHEN t.duration_ms >= th.p95 THEN 'TAIL_P95'
              WHEN t.duration_ms BETWEEN th.p45 AND th.p55 THEN 'TYPICAL_P50'
              ELSE NULL END AS cohort
  FROM turns t CROSS JOIN thresholds th
),
spans AS (
  SELECT c.cohort, s.span_category, s.latency_ms, s.trace_id
  FROM ${FLEET_SCHEMA}.FLEET_SPANS s
  JOIN cohort c ON c.trace_id = s.trace_id
  WHERE c.cohort IS NOT NULL
    AND s.span_category NOT IN ('Agent', 'Agent Wrapper', 'Request Envelope')
)
SELECT
  cohort                                   AS COHORT,
  span_category                            AS SPAN_CATEGORY,
  COUNT(*)                                 AS SPAN_COUNT,
  COUNT(DISTINCT trace_id)                 AS TRACES,
  ROUND(SUM(latency_ms) / NULLIF(COUNT(DISTINCT trace_id), 0)) AS MEAN_MS_PER_TRACE,
  ROUND(APPROX_PERCENTILE(latency_ms, 0.95)) AS P95_SPAN_MS
FROM spans
GROUP BY 1, 2
ORDER BY 1, MEAN_MS_PER_TRACE DESC`;
}

/**
 * Slowest recent traces, for the trace inspector ribbons.
 *
 * Token count comes from a CTE pre-aggregated by trace_id, not a direct join:
 * FLEET_TOKENS is at SPAN grain (several LLM spans per trace), so joining it
 * straight to turns would multiply each trace by its span count and inflate both
 * the row count and any latency aggregate.
 *
 * LEFT JOIN because a trace can legitimately have no LLM span at all - the
 * fast-fail turns that error before a request id is assigned consume zero tokens.
 * An inner join would silently hide exactly the failures worth inspecting.
 */
export function qSlowTraces(w: WindowKey, excludeEval: boolean): string {
  return `
WITH tok AS (
  SELECT trace_id, SUM(total_tokens) AS total_tokens
  FROM ${FLEET_SCHEMA}.FLEET_TOKENS
  GROUP BY trace_id
)
SELECT t.trace_id AS TRACE_ID, t.turn_end_ts AS TURN_END_TS, t.duration_ms AS DURATION_MS,
       t.user_name AS USER_NAME, t.planning_steps AS PLANNING_STEPS,
       t.is_request_error AS IS_REQUEST_ERROR, t.tool_error_count AS TOOL_ERROR_COUNT,
       COALESCE(k.total_tokens, 0) AS TOTAL_TOKENS
FROM ${FLEET_SCHEMA}.FLEET_TURNS t
LEFT JOIN tok k ON k.trace_id = t.trace_id
WHERE t.agent_fqn = ? AND t.turn_end_ts >= ${since(w)}
  ${excludeEval ? "AND NOT t.is_eval_run" : ""}
ORDER BY t.duration_ms DESC NULLS LAST LIMIT 25`;
}

/**
 * Headline KPIs for one agent. Mirrors `qKpis` on the home page so both pages
 * derive the same metrics the same way, with the agent bound as a parameter.
 *
 * THREAD MATH IS NOT COUNT(*) / COUNT(DISTINCT thread_id). `thread_id` is NOT
 * fully populated - 8 of 250 non-eval turns have none - and COUNT(DISTINCT) skips
 * NULLs while COUNT(*) does not, so the naive ratio credits threadless turns to
 * threads that never contained them. Verified on this account: the busiest agent
 * reads 3.77 naive versus 3.50 correct, and BTQ_OPS reads 3.00 versus 2.00.
 * TURNS_IN_THREADS is therefore the numerator, and THREADLESS_TURNS is returned
 * so the UI can disclose what was excluded rather than absorbing it silently.
 */
export function qAgentKpis(w: WindowKey, excludeEval: boolean): string {
  return `
WITH t AS (
  SELECT * FROM ${FLEET_SCHEMA}.FLEET_TURNS
  WHERE agent_fqn = ? AND turn_end_ts >= ${since(w)}
    ${excludeEval ? "AND NOT is_eval_run" : ""}
),
-- Pre-aggregated to request grain BEFORE joining t. FLEET_REQUEST_COST is at
-- (request_id, service_type, model) grain, so a direct join multiplies each turn
-- by its model count. Not COALESCEd to 0: SUM over zero rows yields NULL, which is
-- how the UI tells "not metered yet" from "genuinely free".
cost AS (
  SELECT
    COUNT(*)                   AS priced_requests,
    SUM(c.credits_input)       AS credits_input,
    SUM(c.credits_output)      AS credits_output,
    SUM(c.credits_cache_read)  AS credits_cache_read,
    SUM(c.credits_cache_write) AS credits_cache_write
  FROM (
    SELECT
      request_id,
      SUM(credits_input)       AS credits_input,
      SUM(credits_output)      AS credits_output,
      SUM(credits_cache_read)  AS credits_cache_read,
      SUM(credits_cache_write) AS credits_cache_write
    FROM ${FLEET_SCHEMA}.FLEET_REQUEST_COST
    GROUP BY request_id
  ) c
  JOIN t ON t.request_id = c.request_id
),
thr AS (
  SELECT thread_id, COUNT(*) AS turns_in_thread
  FROM t WHERE thread_id IS NOT NULL
  GROUP BY thread_id
)
SELECT
  (SELECT COUNT(*) FROM t)                            AS REQUESTS,
  (SELECT COUNT_IF(is_request_error) FROM t)           AS REQUEST_ERRORS,
  (SELECT COUNT_IF(has_tool_error) FROM t)             AS TURNS_WITH_TOOL_ERROR,
  (SELECT COUNT_IF(is_degraded_success) FROM t)        AS DEGRADED_SUCCESS,
  (SELECT ROUND(APPROX_PERCENTILE(duration_ms, 0.95)) FROM t WHERE NOT is_request_error) AS P95_MS,
  (SELECT COUNT(*) FROM thr)                           AS THREADS,
  (SELECT COALESCE(SUM(turns_in_thread), 0) FROM thr)  AS TURNS_IN_THREADS,
  (SELECT COUNT_IF(thread_id IS NULL) FROM t)          AS THREADLESS_TURNS,
  (SELECT COALESCE(MAX(turns_in_thread), 0) FROM thr)  AS MAX_TURNS_IN_THREAD,
  (SELECT priced_requests     FROM cost)               AS COST_PRICED_REQUESTS,
  (SELECT credits_input       FROM cost)               AS COST_CREDITS_INPUT,
  (SELECT credits_output      FROM cost)               AS COST_CREDITS_OUTPUT,
  (SELECT credits_cache_read  FROM cost)               AS COST_CREDITS_CACHE_READ,
  (SELECT credits_cache_write FROM cost)               AS COST_CREDITS_CACHE_WRITE`;
}

/** Full span tree for one trace, for the waterfall. */
export const Q_TRACE_SPANS = `
SELECT
  span_id                 AS SPAN_ID,
  parent_span_id          AS PARENT_SPAN_ID,
  span_name               AS SPAN_NAME,
  span_category           AS SPAN_CATEGORY,
  start_ts                AS START_TS,
  end_ts                  AS END_TS,
  latency_ms              AS LATENCY_MS,
  has_invalid_duration    AS HAS_INVALID_DURATION,
  step_number             AS STEP_NUMBER,
  model_name              AS MODEL_NAME,
  tool_status             AS TOOL_STATUS,
  tool_status_description AS TOOL_STATUS_DESCRIPTION,
  planning_status         AS PLANNING_STATUS,
  is_tool_error           AS IS_TOOL_ERROR
FROM ${FLEET_SCHEMA}.FLEET_SPANS
WHERE trace_id = ?
ORDER BY start_ts, latency_ms DESC`;

export function qAgentUsersRoles(w: WindowKey, excludeEval: boolean): string {
  return `
SELECT
  COALESCE(user_name, '(unattributed)') AS USER_NAME,
  COALESCE(role_name, '(unattributed)') AS ROLE_NAME,
  COUNT(*)                              AS REQUESTS,
  COUNT_IF(is_request_error)            AS ERRORS,
  MAX(turn_end_ts)                      AS LAST_SEEN
FROM ${FLEET_SCHEMA}.FLEET_TURNS
WHERE agent_fqn = ? AND turn_end_ts >= ${since(w)}
  ${excludeEval ? "AND NOT is_eval_run" : ""}
GROUP BY 1, 2 ORDER BY REQUESTS DESC LIMIT 20`;
}

export function qAgentFeedbackTrend(w: WindowKey): string {
  const b = bucket(w);
  return `
SELECT
  DATE_TRUNC('${b}', feedback_ts) AS TS,
  COUNT_IF(is_positive)           AS POSITIVE,
  COUNT_IF(NOT is_positive)       AS NEGATIVE
FROM ${FLEET_SCHEMA}.FLEET_FEEDBACK
WHERE agent_fqn = ? AND feedback_ts >= ${since(w)}
GROUP BY 1 ORDER BY 1`;
}

export const Q_AGENT_LIST = `
SELECT agent_fqn AS AGENT_FQN, display_name AS DISPLAY_NAME,
       agent_name AS AGENT_NAME, turns_total AS TURNS_TOTAL,
       agent_database AS AGENT_DATABASE, agent_schema AS AGENT_SCHEMA,
       agent_owner AS AGENT_OWNER, profile_color AS PROFILE_COLOR,
       distinct_users AS DISTINCT_USERS, last_turn_ts AS LAST_TURN_TS
FROM ${FLEET_SCHEMA}.FLEET_AGENT_INVENTORY
ORDER BY turns_total DESC, display_name`;

/* ---------------------------------------------------------------------------
   PAGE 4 - feedback
   ------------------------------------------------------------------------ */

export const Q_FEEDBACK_SUMMARY = `
SELECT
  COUNT(*)                  AS TOTAL,
  COUNT_IF(is_positive)     AS POSITIVE,
  COUNT_IF(NOT is_positive) AS NEGATIVE,
  COUNT(DISTINCT agent_fqn) AS AGENTS,
  COUNT(DISTINCT user_name) AS USERS,
  MIN(feedback_ts)          AS FIRST_TS,
  MAX(feedback_ts)          AS LAST_TS
FROM ${FLEET_SCHEMA}.FLEET_FEEDBACK`;

/**
 * Negative feedback categories. `categories` is a free-form array of strings
 * with no documented enumeration, so values are discovered here at query time.
 * A hardcoded enum would silently drop unrecognised categories.
 */
export const Q_FEEDBACK_CATEGORIES = `
SELECT
  f.value::STRING           AS CATEGORY,
  COUNT(*)                  AS N,
  COUNT(DISTINCT fb.agent_fqn) AS AGENTS
FROM ${FLEET_SCHEMA}.FLEET_FEEDBACK fb,
     LATERAL FLATTEN(INPUT => fb.categories) f
WHERE NOT fb.is_positive
GROUP BY 1 ORDER BY N DESC`;

/** Negative feedback with no category at all - a real and common case here. */
export const Q_FEEDBACK_UNCATEGORIZED = `
SELECT COUNT(*) AS N
FROM ${FLEET_SCHEMA}.FLEET_FEEDBACK
WHERE NOT is_positive AND (categories IS NULL OR ARRAY_SIZE(categories) = 0)`;

export const Q_FEEDBACK_ITEMS = `
SELECT
  record_id        AS RECORD_ID,
  agent_fqn        AS AGENT_FQN,
  agent_name       AS AGENT_NAME,
  feedback_ts      AS FEEDBACK_TS,
  user_name        AS USER_NAME,
  role_name        AS ROLE_NAME,
  is_positive      AS IS_POSITIVE,
  feedback_message AS FEEDBACK_MESSAGE,
  categories       AS CATEGORIES,
  thread_id        AS THREAD_ID
FROM ${FLEET_SCHEMA}.FLEET_FEEDBACK
ORDER BY feedback_ts DESC`;

export const Q_FEEDBACK_BY_AGENT = `
SELECT
  agent_fqn                 AS AGENT_FQN,
  agent_name                AS AGENT_NAME,
  COUNT(*)                  AS TOTAL,
  COUNT_IF(is_positive)     AS POSITIVE,
  COUNT_IF(NOT is_positive) AS NEGATIVE
FROM ${FLEET_SCHEMA}.FLEET_FEEDBACK
GROUP BY 1, 2 ORDER BY TOTAL DESC`;
