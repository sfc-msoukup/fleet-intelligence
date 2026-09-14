/* =============================================================================
   Cortex Agent Fleet Intelligence — one-shot installer (setup.sql)

   Stands up EVERYTHING the dashboard needs in a fresh Snowflake account:
   a dedicated database + schema, the FLEET_* tables, the refresh procedure,
   a serverless refresh task, a standard warehouse, an optional interactive
   warehouse, a least-privilege application role, and an initial data load.

   The APPLICATION SERVICE (the web app itself) is deployed separately with
   `snow app deploy` — a built Next.js artifact cannot be created from SQL.
   See README.md -> "Deploy from scratch".

   ---------------------------------------------------------------------------
   PREREQUISITES
   - Run as ACCOUNTADMIN (or a role that can CREATE DATABASE / WAREHOUSE / ROLE,
     GRANT the SNOWFLAKE database + application roles below, and read
     SNOWFLAKE.LOCAL / SNOWFLAKE.ACCOUNT_USAGE). The refresh procedure is
     EXECUTE AS CALLER and reads account-level AI observability + cost metering.
   - The account must have Cortex Agents and AI Observability enabled
     (the view SNOWFLAKE.LOCAL.AI_OBSERVABILITY_EVENTS must be queryable).

   RUN
     snow sql -c <YOUR_CONNECTION> -f setup.sql

   ---------------------------------------------------------------------------
   TO USE DIFFERENT NAMES
   This installer targets FLEET_INTELLIGENCE.OBSERVABILITY. To rename, find and
   replace these identifiers consistently in THIS file:
       FLEET_INTELLIGENCE       -> your database
       OBSERVABILITY            -> your schema
       FLEET_INTELLIGENCE_WH    -> your standard  warehouse   (optional)
       FLEET_INTELLIGENCE_IWH   -> your interactive warehouse (optional)
       FLEET_APP_ROLE           -> your app role              (optional)
   ...and set the matching values when you deploy the app (README -> Deploy):
       NEXT_PUBLIC_FLEET_SCHEMA = <your_database>.<your_schema>   (build-time)
       FLEET_READ_WAREHOUSE     = <interactive or standard warehouse>
       FLEET_WRITE_WAREHOUSE    = <standard warehouse>
   NEXT_PUBLIC_FLEET_SCHEMA is a BUILD-time var (the in-app SQL popovers render
   the schema client-side), so it must be set when the app is built, not just
   at runtime.
   ============================================================================= */

-- Everything below assumes an admin role. Swap for another sufficiently
-- privileged role if you do not use ACCOUNTADMIN, but note the SNOWFLAKE
-- database/application role grants in STEP 3 require an account admin.
USE ROLE ACCOUNTADMIN;

/* -----------------------------------------------------------------------------
   STEP 1 — database, schema, and the standard warehouse.

   The standard warehouse serves the app's write path (the FLEET_CONFIG MERGE,
   which an interactive warehouse rejects), the initial load below, and doubles
   as the read/fallback warehouse on accounts without interactive-warehouse
   support. XSMALL is deliberate: the whole data set is ~1.3 MB (GROUNDING.md
   section 4b) so a larger size buys nothing.
   -------------------------------------------------------------------------- */
CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE;
USE DATABASE FLEET_INTELLIGENCE;
CREATE SCHEMA IF NOT EXISTS OBSERVABILITY;
USE SCHEMA FLEET_INTELLIGENCE.OBSERVABILITY;

CREATE WAREHOUSE IF NOT EXISTS FLEET_INTELLIGENCE_WH
    WAREHOUSE_SIZE      = 'XSMALL'
    AUTO_SUSPEND        = 60
    AUTO_RESUME         = TRUE
    INITIALLY_SUSPENDED = TRUE
    COMMENT = 'Standard warehouse for Fleet Intelligence: app write path (FLEET_CONFIG MERGE), initial load, and interactive-warehouse fallback.';
USE WAREHOUSE FLEET_INTELLIGENCE_WH;

/* =============================================================================
   STEP 2 — tables, seeds, and the refresh procedure.

   Reproduced verbatim from sql/01_data_layer.sql, re-pointed to this schema.
   See that file and GROUNDING.md for the reasoning behind every design choice
   (INSERT OVERWRITE vs CREATE OR REPLACE, the token source, the cost-step
   exception handler, UTC windowing, etc.). Do not "simplify" these — each
   choice was validated against real account data.
   ============================================================================= */
/* -----------------------------------------------------------------------------
   1. Configuration: hex status thresholds and default windows.
      Editable from the app; the app never hardcodes these.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS FLEET_CONFIG (
    CONFIG_KEY    STRING NOT NULL,
    CONFIG_VALUE  STRING NOT NULL,
    VALUE_TYPE    STRING NOT NULL,
    DESCRIPTION   STRING,
    UPDATED_AT    TIMESTAMP_NTZ DEFAULT SYSDATE(),
    CONSTRAINT PK_FLEET_CONFIG PRIMARY KEY (CONFIG_KEY)
);

MERGE INTO FLEET_CONFIG t
USING (
    SELECT * FROM VALUES
      ('hex.green_minutes',      '60',    'INT',  'Success within N minutes renders GREEN'),
      ('hex.yellow_hours',       '24',    'INT',  'Success within N hours renders YELLOW'),
      ('hex.red_hours',          '24',    'INT',  'Error within N hours renders RED (takes precedence)'),
      ('hex.red_includes_tool',  'false', 'BOOL', 'If true, tool-level failures also trigger RED; if false, only request-level errors'),
      ('kpi.default_window',     '24h',   'ENUM', 'Default KPI window: 60m | 24h | 7d | 30d | 90d | 180d | 365d'),
      ('fleet.exclude_eval_runs','true',  'BOOL', 'Exclude evaluation-harness-driven turns from fleet metrics'),
      ('sat.warn_pct',           '60',    'INT',  'Saturation warn threshold (percent of limit)'),
      ('sat.page_pct',           '80',    'INT',  'Saturation page threshold (percent of limit)'),
      ('cost.usd_per_ai_credit', '2.00',  'FLOAT','USD per Snowflake AI Credit. 2.00 = global inference routing, 2.20 = regional')
    AS v(k, val, vt, descr)
) s
ON t.CONFIG_KEY = s.k
WHEN NOT MATCHED THEN
    INSERT (CONFIG_KEY, CONFIG_VALUE, VALUE_TYPE, DESCRIPTION)
    VALUES (s.k, s.val, s.vt, s.descr);

/* -----------------------------------------------------------------------------
   2. Rate limits, with provenance so the UI can show where each number
      came from. Per-model rows are refreshed from the live account view;
      named limits are seeded here.

      IF NOT EXISTS rather than OR REPLACE for the same reason the derived
      tables use INSERT OVERWRITE: re-running this file must not mint a new
      object, or it silently falls out of the interactive warehouse's cache
      list and loses its grants. The procedure already refreshes the contents
      with DELETE + INSERT.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS FLEET_RATE_LIMITS (
    LIMIT_SCOPE   STRING,   -- MODEL | AGENT_API | SEARCH_SERVICE | SEARCH_ACCOUNT
    LIMIT_KEY     STRING,   -- model name, or a named key
    METRIC        STRING,   -- RPM | TPM | QPS
    LIMIT_VALUE   NUMBER,
    SOURCE        STRING,   -- account_view | public_docs | internal_verified
    NOTE          STRING,
    REFRESHED_AT  TIMESTAMP_NTZ
);

/* -----------------------------------------------------------------------------
   2b. Request cost, priced by Snowflake's own metering.

       Declared HERE rather than inside the procedure, unlike every other derived
       table. The cost step is the only one that reads views the task owner can
       lose access to (see the header note and GROUNDING.md), so it runs inside an
       EXCEPTION handler. If that handler ever fires on a fresh install and the
       table had been created lazily by the procedure, the object would not exist
       at all and every KPI query joining it would fail - turning a cost outage
       into a total dashboard outage. Creating it up front means the worst case is
       an empty cost table and a blank cost card.

       IF NOT EXISTS, not OR REPLACE, for the interactive-warehouse cache and
       grant reasons described in the header.
   -------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS FLEET_REQUEST_COST (
    SURFACE              STRING,        -- cortex_agent | cowork
    REQUEST_ID           STRING,        -- row-level id; joins FLEET_TURNS.request_id
    AGENT_FQN            STRING,        -- NULL for inline agents (AGENT_ID = 0)
    TS_UTC               TIMESTAMP_NTZ, -- START_TIME converted to UTC to match turns
    SERVICE_TYPE         STRING,        -- cortex_agents | cortex_analyst
    MODEL                STRING,        -- model name, or 'unknown'
    CREDITS_INPUT        FLOAT,
    CREDITS_OUTPUT       FLOAT,
    CREDITS_CACHE_READ   FLOAT,
    CREDITS_CACHE_WRITE  FLOAT
);

/* -----------------------------------------------------------------------------
   3. Refresh procedure. Full rebuild each run: the source is small
      (~106k rows) and a full rebuild avoids incremental-merge drift. The
      rebuild lands via INSERT OVERWRITE into a stable table object - see the
      header note on why the object must not be replaced.
   -------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE REFRESH_FLEET_OBSERVABILITY()
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
    n_agents   INT;
    n_turns    INT;
    n_spans    INT;
    n_tokens   INT;
    n_search   INT;
    n_feedback INT;
    n_cost     INT;
BEGIN

    -- Pin the schema so this procedure is independent of the caller's session
    -- context. A serverless task and the app connect with different defaults,
    -- and unqualified TEMPORARY tables need a current schema.
    USE SCHEMA FLEET_INTELLIGENCE.OBSERVABILITY;

    -- 3a. Agent inventory. SHOW AGENTS gives the authoritative object list
    --     (including agents with zero traffic) plus the profile blob that
    --     carries display_name and colour.
    SHOW AGENTS IN ACCOUNT;

    CREATE OR REPLACE TEMPORARY TABLE _agents_raw AS
    SELECT
        "database_name"::STRING AS agent_database,
        "schema_name"::STRING   AS agent_schema,
        "name"::STRING          AS agent_name,
        "owner"::STRING         AS agent_owner,
        "comment"::STRING       AS agent_comment,
        TRY_PARSE_JSON("profile") AS profile_json,
        "created_on"::TIMESTAMP_LTZ AS created_on
    FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));

    -- 3b. Normalised event base. One pass over the flat view.
    CREATE OR REPLACE TEMPORARY TABLE _ev AS
    SELECT
        TIMESTAMP                                                     AS ts,
        START_TIMESTAMP                                               AS start_ts,
        TRACE['trace_id']::STRING                                     AS trace_id,
        TRACE['span_id']::STRING                                      AS span_id,
        RECORD['parent_span_id']::STRING                              AS parent_span_id,
        RECORD['name']::STRING                                        AS span_name,
        RECORD['status']['code']::STRING                              AS otel_status,
        RECORD_ATTRIBUTES                                             AS ra,
        RESOURCE_ATTRIBUTES                                           AS rsa,
        VALUE                                                         AS val,
        RECORD_ATTRIBUTES['ai.observability.span_type']::STRING       AS span_type,
        RECORD_ATTRIBUTES['snow.ai.observability.database.name']::STRING AS agent_database,
        RECORD_ATTRIBUTES['snow.ai.observability.schema.name']::STRING   AS agent_schema,
        RECORD_ATTRIBUTES['snow.ai.observability.object.name']::STRING   AS agent_name,
        RECORD_ATTRIBUTES['snow.ai.observability.run.name'] IS NOT NULL  AS is_eval_run
    FROM SNOWFLAKE.LOCAL.AI_OBSERVABILITY_EVENTS
    WHERE UPPER(RECORD_ATTRIBUTES['snow.ai.observability.object.type']::STRING) = 'CORTEX AGENT'
      AND COALESCE(RECORD_ATTRIBUTES['ai.observability.span_type']::STRING, '')
            NOT IN ('eval_root', 'eval', 'cortex_agent_ground_truth')
      AND RECORD['name']::STRING IS NOT NULL;

    -- 3c. Turns. Grain: one row per agent turn.
    --     AgentV2RequestResponseInfo is the root span: it is the only span
    --     carrying agent.duration, and its count matches CORTEX_AGENT_REQUEST.
    CREATE OR REPLACE TEMPORARY TABLE _new_turns AS
    WITH root AS (
        SELECT
            agent_database, agent_schema, agent_name, is_eval_run,
            trace_id, span_id, ts, start_ts,
            -- Validated on root spans: record_id has no 'snow.' prefix, and
            -- user/role live in RESOURCE_ATTRIBUTES (321/321 populated),
            -- not RECORD_ATTRIBUTES (0/321).
            ra['ai.observability.record_id']::STRING                 AS record_id,
            ra['snow.ai.observability.agent.request_id']::STRING     AS request_id,
            ra['snow.ai.observability.agent.thread_id']::NUMBER      AS thread_id,
            rsa['snow.user.name']::STRING                           AS user_name,
            rsa['snow.session.role.primary.name']::STRING           AS role_name,
            ra['snow.ai.observability.agent.status']::STRING        AS agent_status,
            ra['snow.ai.observability.agent.status.code']::STRING   AS agent_status_code,
            ra['snow.ai.observability.agent.status.description']::STRING AS agent_status_desc,
            ra['snow.ai.observability.object.version.name']::STRING AS agent_version,
            COALESCE(
                ra['snow.ai.observability.agent.duration']::FLOAT,
                DATEDIFF('millisecond', start_ts, ts)
            )                                                       AS duration_ms,
            ra['ai.observability.record_root.output']::STRING       AS output_text
        FROM _ev
        WHERE span_name = 'AgentV2RequestResponseInfo'
    ),
    -- Tool-level failures rolled up per trace. A turn can report 200 overall
    -- while an individual tool failed, so these are tracked separately and
    -- never merged into the request-level error flag.
    tool_err AS (
        SELECT
            trace_id,
            COUNT(*) AS tool_error_count
        FROM _ev, LATERAL FLATTEN(INPUT => ra) f
        WHERE f.key LIKE 'snow.ai.observability.agent.tool.%.status'
          AND f.value::STRING = 'ERROR'
        GROUP BY trace_id
    ),
    steps AS (
        SELECT trace_id, COUNT(*) AS planning_steps
        FROM _ev
        WHERE span_name LIKE 'ReasoningAgentStepPlanning-%'
        GROUP BY trace_id
    )
    SELECT
        r.agent_database,
        r.agent_schema,
        r.agent_name,
        r.agent_database || '.' || r.agent_schema || '.' || r.agent_name AS agent_fqn,
        r.is_eval_run,
        r.trace_id,
        r.span_id                                     AS root_span_id,
        r.record_id,
        r.request_id,
        r.thread_id,
        r.user_name,
        r.role_name,
        r.ts                                          AS turn_end_ts,
        r.start_ts                                    AS turn_start_ts,
        r.duration_ms,
        r.agent_status,
        r.agent_status_code,
        r.agent_status_desc,
        r.agent_version,
        -- Request-level error: the root status description is the only place
        -- failure surfaces, since status.code is 200 on every turn here.
        (r.agent_status_desc = 'ERROR')               AS is_request_error,
        -- 200-with-unusable-payload. Agents fail inside a 200.
        (r.output_text IS NULL OR TRIM(r.output_text) = ''
         OR r.output_text ILIKE 'Unable to respond%') AS is_degraded_success,
        (r.agent_status_desc = 'SLOW')                AS is_flagged_slow,
        COALESCE(te.tool_error_count, 0)              AS tool_error_count,
        (COALESCE(te.tool_error_count, 0) > 0)        AS has_tool_error,
        COALESCE(st.planning_steps, 0)                AS planning_steps
    FROM root r
    LEFT JOIN tool_err te ON r.trace_id = te.trace_id
    LEFT JOIN steps    st ON r.trace_id = st.trace_id;
    CREATE TABLE IF NOT EXISTS FLEET_TURNS LIKE _new_turns;
    INSERT OVERWRITE INTO FLEET_TURNS SELECT * FROM _new_turns;

    -- 3d. Spans. Grain: one row per span, with parent linkage for the
    --     waterfall and critical path. Tool identity is read from structured
    --     attributes where available and falls back to span-name parsing.
    CREATE OR REPLACE TEMPORARY TABLE _new_spans AS
    WITH tool_attr AS (
        -- Per-tool status keys are named
        -- snow.ai.observability.agent.tool.<TOOL_TYPE>.status[.description].
        -- Flattened once and aggregated per span rather than read with a
        -- correlated subquery, which Snowflake cannot evaluate. Deriving
        -- TOOL_TYPE from the key means new tool types are picked up
        -- automatically instead of needing a hardcoded list.
        SELECT
            e.span_id,
            MAX(IFF(f.key RLIKE '^snow\\.ai\\.observability\\.agent\\.tool\\.[^.]+\\.status$',
                    f.value::STRING, NULL))                       AS tool_status,
            MAX(IFF(f.key RLIKE '^snow\\.ai\\.observability\\.agent\\.tool\\.[^.]+\\.status\\.description$',
                    f.value::STRING, NULL))                       AS tool_status_description,
            MAX(IFF(f.key RLIKE '^snow\\.ai\\.observability\\.agent\\.tool\\.[^.]+\\.status$',
                    REGEXP_SUBSTR(f.key, 'tool\\.([^.]+)\\.status$', 1, 1, 'e', 1),
                    NULL))                                        AS tool_type
        FROM _ev e, LATERAL FLATTEN(INPUT => e.ra) f
        WHERE f.key LIKE 'snow.ai.observability.agent.tool.%'
        GROUP BY e.span_id
    )
    SELECT
        s.agent_database,
        s.agent_schema,
        s.agent_name,
        s.agent_database || '.' || s.agent_schema || '.' || s.agent_name AS agent_fqn,
        s.is_eval_run,
        s.trace_id,
        s.span_id,
        s.parent_span_id,
        s.span_name,
        s.start_ts,
        s.ts                                                      AS end_ts,
        -- Some spans emit START_TIMESTAMP after TIMESTAMP, yielding a negative
        -- duration. UserMemoryInjection does this on 100% of rows (-60s to
        -- -13s) and root Agent spans on 10 of 321 (min -416ms, clock skew).
        -- Nulled rather than clamped to 0: NULL is excluded from percentiles and
        -- sums automatically, whereas a 0 would silently understate real work.
        -- The raw value is kept so the anomaly stays auditable.
        IFF(DATEDIFF('millisecond', s.start_ts, s.ts) >= 0,
            DATEDIFF('millisecond', s.start_ts, s.ts), NULL)      AS latency_ms,
        DATEDIFF('millisecond', s.start_ts, s.ts)                 AS latency_ms_raw,
        (DATEDIFF('millisecond', s.start_ts, s.ts) < 0)           AS has_invalid_duration,
        s.rsa['snow.user.name']::STRING                           AS user_name,
        s.rsa['snow.session.role.primary.name']::STRING           AS role_name,
        s.ra['snow.ai.observability.agent.thread_id']::NUMBER      AS thread_id,
        CASE
            WHEN s.span_name = 'AgentV2RequestResponseInfo'                     THEN 'Agent'
            WHEN s.span_name LIKE 'ReasoningAgentStepPlanning%'                  THEN 'LLM Planning'
            WHEN s.span_name LIKE 'ReasoningAgentStepResponseGeneration%'        THEN 'LLM Response Generation'
            WHEN s.span_name LIKE 'SemanticContextTool%'                         THEN 'Semantic Context'
            WHEN s.span_name = 'SystemExecuteSQLTool_system_execute_sql'         THEN 'SQL Execution'
            WHEN s.span_name LIKE 'ServerSkillTool%'                             THEN 'Skill'
            WHEN s.span_name LIKE 'CortexChartToolImpl%'                         THEN 'Chart Generation'
            WHEN s.span_name LIKE 'CortexSearchService%'                         THEN 'Cortex Search'
            WHEN s.span_name LIKE 'CortexAnalystTool%'                           THEN 'Cortex Analyst'
            WHEN s.span_name LIKE 'CodeExecutionTool%'                           THEN 'Code Execution'
            WHEN s.span_name LIKE 'ToolCall%'                                    THEN 'Tool Call'
            WHEN s.span_name LIKE 'SqlExecution%'                                THEN 'SQL Execution (inner)'
            WHEN s.span_name = 'CORTEX_AGENT_REQUEST'                            THEN 'Request Envelope'
            WHEN s.span_name = 'Agent'                                           THEN 'Agent Wrapper'
            WHEN s.span_name = 'UserMemoryInjection'                             THEN 'Memory Injection'
            ELSE 'Other'
        END                                                       AS span_category,
        -- Resource names. SUBSTR from the first '_' + 1 consistently
        -- (the starter SQL used two different forms for this).
        IFF(s.span_name LIKE 'SemanticContextTool%',
            SUBSTR(s.span_name, POSITION('_' IN s.span_name) + 1), NULL) AS semantic_view,
        IFF(s.span_name LIKE 'CortexSearchService%',
            SUBSTR(s.span_name, POSITION('_' IN s.span_name) + 1), NULL) AS cortex_search,
        IFF(s.span_name LIKE 'CortexAnalystTool%',
            SUBSTR(s.span_name, POSITION('_' IN s.span_name) + 1), NULL) AS cortex_analyst,
        IFF(s.span_name LIKE 'ServerSkillTool%',
            SUBSTR(s.span_name, POSITION('_' IN s.span_name) + 1), NULL) AS skill_name,
        IFF(s.span_name LIKE 'CortexChartToolImpl%',
            SPLIT_PART(s.span_name, '-', 2), NULL)                       AS chart_tool,
        IFF(s.span_name LIKE 'ToolCall%',
            SPLIT_PART(s.span_name, '-', 2), NULL)                       AS tool_name,
        -- Structured tool attributes: more reliable than name parsing.
        s.ra['snow.ai.observability.agent.planning.tool.name']::STRING  AS planning_tool_name,
        s.ra['snow.ai.observability.agent.planning.tool.type']::STRING  AS planning_tool_type,
        s.ra['snow.ai.observability.agent.planning.step_number']::INT   AS step_number,
        s.ra['snow.ai.observability.agent.planning.model']::STRING      AS model_name,
        s.otel_status,
        ta.tool_type,
        ta.tool_status,
        ta.tool_status_description,
        (ta.tool_status = 'ERROR')                                     AS is_tool_error,
        s.ra['snow.ai.observability.agent.planning.status']::STRING     AS planning_status,
        s.ra['snow.ai.observability.agent.planning.status.description']::STRING AS planning_status_description
    FROM _ev s
    LEFT JOIN tool_attr ta ON s.span_id = ta.span_id;
    CREATE TABLE IF NOT EXISTS FLEET_SPANS LIKE _new_spans;
    INSERT OVERWRITE INTO FLEET_SPANS SELECT * FROM _new_spans;

    -- 3e. Tokens. Grain: one row per LLM span (planning or response
    --     generation) with model attribution. This is the complete source:
    --     every such span has both tokens and a model name.
    CREATE OR REPLACE TEMPORARY TABLE _new_tokens AS
    SELECT
        agent_database,
        agent_schema,
        agent_name,
        agent_database || '.' || agent_schema || '.' || agent_name AS agent_fqn,
        is_eval_run,
        trace_id,
        span_id,
        ts                                                        AS ts,
        DATE_TRUNC('minute', ts)                                  AS ts_minute,
        span_name,
        IFF(span_name LIKE 'ReasoningAgentStepPlanning%',
            'Planning', 'Response Generation')                    AS llm_phase,
        ra['snow.ai.observability.agent.planning.model']::STRING   AS model_name,
        rsa['snow.user.name']::STRING                              AS user_name,
        rsa['snow.session.role.primary.name']::STRING              AS role_name,
        ra['snow.ai.observability.agent.planning.token_count.cache_read_input']::INT  AS cache_read_input_tokens,
        ra['snow.ai.observability.agent.planning.token_count.cache_write_input']::INT AS cache_write_input_tokens,
        ra['snow.ai.observability.agent.planning.token_count.input']::INT             AS input_tokens,
        ra['snow.ai.observability.agent.planning.token_count.output']::INT            AS output_tokens,
        ra['snow.ai.observability.agent.planning.token_count.plan']::INT              AS plan_tokens,
        ra['snow.ai.observability.agent.planning.token_count.total']::INT             AS total_tokens
    FROM _ev
    WHERE span_name LIKE 'ReasoningAgentStepPlanning%'
       OR span_name LIKE 'ReasoningAgentStepResponseGeneration%';
    CREATE TABLE IF NOT EXISTS FLEET_TOKENS LIKE _new_tokens;
    INSERT OVERWRITE INTO FLEET_TOKENS SELECT * FROM _new_tokens;

    -- 3f. Feedback. categories is an open set: no enumeration is documented,
    --     so values are discovered at query time rather than mapped to an enum.
    CREATE OR REPLACE TEMPORARY TABLE _new_feedback AS
    SELECT
        RECORD_ATTRIBUTES['snow.ai.observability.database.name']::STRING AS agent_database,
        RECORD_ATTRIBUTES['snow.ai.observability.schema.name']::STRING   AS agent_schema,
        RECORD_ATTRIBUTES['snow.ai.observability.object.name']::STRING   AS agent_name,
        RECORD_ATTRIBUTES['snow.ai.observability.database.name']::STRING || '.' ||
        RECORD_ATTRIBUTES['snow.ai.observability.schema.name']::STRING   || '.' ||
        RECORD_ATTRIBUTES['snow.ai.observability.object.name']::STRING   AS agent_fqn,
        TIMESTAMP                                                        AS feedback_ts,
        RECORD_ATTRIBUTES['ai.observability.record_id']::STRING           AS record_id,
        RECORD_ATTRIBUTES['snow.ai.observability.agent.thread_id']::STRING AS thread_id,
        RECORD_ATTRIBUTES['snow.ai.observability.user.name']::STRING       AS user_name,
        RECORD_ATTRIBUTES['snow.ai.observability.role.name']::STRING       AS role_name,
        IFF(IS_NULL_VALUE(VALUE['feedback_message']), NULL,
            VALUE['feedback_message'])::STRING                            AS feedback_message,
        (VALUE['positive']::STRING = 'true')                              AS is_positive,
        IFF(IS_NULL_VALUE(VALUE['categories']), NULL,
            VALUE['categories'])                                          AS categories
    FROM SNOWFLAKE.LOCAL.AI_OBSERVABILITY_EVENTS
    WHERE RECORD['name']::STRING = 'CORTEX_AGENT_FEEDBACK';
    CREATE TABLE IF NOT EXISTS FLEET_FEEDBACK LIKE _new_feedback;
    INSERT OVERWRITE INTO FLEET_FEEDBACK SELECT * FROM _new_feedback;

    -- 3g. Cortex Search requests. Only populated for services with
    --     REQUEST_LOGGING = TRUE. Second-grain bucket is pre-computed because
    --     the QPS limits are per second, not per minute.
    CREATE OR REPLACE TEMPORARY TABLE _new_search_requests AS
    SELECT
        RECORD_ATTRIBUTES['snow.ai.observability.database.name']::STRING AS service_database,
        RECORD_ATTRIBUTES['snow.ai.observability.schema.name']::STRING   AS service_schema,
        RECORD_ATTRIBUTES['snow.ai.observability.object.name']::STRING   AS service_name,
        RECORD_ATTRIBUTES['snow.ai.observability.database.name']::STRING || '.' ||
        RECORD_ATTRIBUTES['snow.ai.observability.schema.name']::STRING   || '.' ||
        RECORD_ATTRIBUTES['snow.ai.observability.object.name']::STRING   AS service_fqn,
        TIMESTAMP                                                        AS ts,
        DATE_TRUNC('second', TIMESTAMP)                                  AS ts_second,
        DATE_TRUNC('minute', TIMESTAMP)                                  AS ts_minute,
        VALUE['snow.ai.observability.operation_type']::STRING             AS operation_type,
        VALUE['snow.ai.observability.response_status_code']::INT          AS status_code,
        VALUE['snow.ai.observability.response_time_ms']::FLOAT            AS response_time_ms,
        (VALUE['snow.ai.observability.response_status_code']::INT = 429)   AS is_throttled,
        (VALUE['snow.ai.observability.response_status_code']::INT = 200)   AS is_success
    FROM SNOWFLAKE.LOCAL.AI_OBSERVABILITY_EVENTS
    WHERE RECORD['name']::STRING = 'CORTEX_SEARCH_REQUEST';
    CREATE TABLE IF NOT EXISTS FLEET_SEARCH_REQUESTS LIKE _new_search_requests;
    INSERT OVERWRITE INTO FLEET_SEARCH_REQUESTS SELECT * FROM _new_search_requests;

    -- 3h. Agent inventory joined to derived activity, so agents with zero
    --     traffic still appear on the hex panel.
    CREATE OR REPLACE TEMPORARY TABLE _new_agent_inventory AS
    WITH activity AS (
        SELECT
            agent_fqn,
            COUNT(*)                                            AS turns_total,
            MAX(turn_end_ts)                                    AS last_turn_ts,
            MAX(IFF(NOT is_request_error, turn_end_ts, NULL))    AS last_success_ts,
            MAX(IFF(is_request_error, turn_end_ts, NULL))        AS last_request_error_ts,
            MAX(IFF(has_tool_error, turn_end_ts, NULL))          AS last_tool_error_ts,
            COUNT(DISTINCT user_name)                            AS distinct_users
        FROM FLEET_TURNS
        WHERE NOT is_eval_run
        GROUP BY agent_fqn
    )
    SELECT
        a.agent_database,
        a.agent_schema,
        a.agent_name,
        a.agent_database || '.' || a.agent_schema || '.' || a.agent_name AS agent_fqn,
        a.agent_owner,
        a.agent_comment,
        COALESCE(a.profile_json['display_name']::STRING, a.agent_name)   AS display_name,
        a.profile_json['color']::STRING                                  AS profile_color,
        a.created_on,
        COALESCE(act.turns_total, 0)      AS turns_total,
        act.last_turn_ts,
        act.last_success_ts,
        act.last_request_error_ts,
        act.last_tool_error_ts,
        COALESCE(act.distinct_users, 0)   AS distinct_users
    FROM _agents_raw a
    LEFT JOIN activity act
      ON act.agent_fqn = a.agent_database || '.' || a.agent_schema || '.' || a.agent_name;
    CREATE TABLE IF NOT EXISTS FLEET_AGENT_INVENTORY LIKE _new_agent_inventory;
    INSERT OVERWRITE INTO FLEET_AGENT_INVENTORY SELECT * FROM _new_agent_inventory;

    -- 3i. Rate limits. Per-model rows come from the live account view so the
    --     app never hardcodes them; named limits are seeded with provenance.
    CREATE OR REPLACE TEMPORARY TABLE _limits AS
    SELECT 'MODEL' AS LIMIT_SCOPE, MODEL_NAME AS LIMIT_KEY, 'RPM' AS METRIC,
           RPM AS LIMIT_VALUE, 'account_view' AS SOURCE,
           'CORTEX_REST_API_RATE_LIMIT_POLICIES' AS NOTE
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_RATE_LIMIT_POLICIES
    WHERE RPM IS NOT NULL
    UNION ALL
    SELECT 'MODEL', MODEL_NAME, 'TPM', TPM, 'account_view',
           'CORTEX_REST_API_RATE_LIMIT_POLICIES'
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_RATE_LIMIT_POLICIES
    WHERE TPM IS NOT NULL
    UNION ALL
    SELECT 'AGENT_API', 'ALL_AGENTS', 'RPM', 500, 'internal_verified',
           'Cortex Agent API cap: 500 requests per account per minute. Applies in addition to per-model Cortex REST API limits.'
    UNION ALL
    SELECT 'SEARCH_SERVICE', 'PER_SERVICE', 'QPS', 20, 'public_docs',
           'Cortex Search: 20 QPS per single search service'
    UNION ALL
    SELECT 'SEARCH_ACCOUNT', 'ALL_SERVICES', 'QPS', 140, 'public_docs',
           'Cortex Search: 140 QPS across all services in the account';

    DELETE FROM FLEET_RATE_LIMITS;
    INSERT INTO FLEET_RATE_LIMITS
        (LIMIT_SCOPE, LIMIT_KEY, METRIC, LIMIT_VALUE, SOURCE, NOTE, REFRESHED_AT)
    SELECT LIMIT_SCOPE, LIMIT_KEY, METRIC, LIMIT_VALUE, SOURCE, NOTE, SYSDATE()
    FROM _limits;

    -- 3j. Request cost, from Snowflake's own metering.
    --
    --     Grain: one row per (surface, request_id, service_type, model).
    --
    --     ISOLATED IN AN EXCEPTION HANDLER ON PURPOSE. This is the only step that
    --     reads SNOWFLAKE.ACCOUNT_USAGE cost views, and those grant SELECT to
    --     ACCOUNTADMIN and ACCOUNT_BUDGET_ADMIN only - SNOWFLAKE.USAGE_VIEWER does
    --     NOT cover them (verified with SHOW GRANTS ON VIEW). The procedure is
    --     EXECUTE AS CALLER, so a task re-owned to a lesser role loses access here.
    --     Unhandled, that single failure would abort the whole procedure and leave
    --     all nine other tables stale. Handled, cost goes blank and everything else
    --     stays fresh.
    BEGIN
        -- No TEMP staging table here: FLEET_REQUEST_COST is declared with explicit
        -- DDL in section 2b, so INSERT OVERWRITE can load it directly. Still
        -- INSERT OVERWRITE rather than CREATE OR REPLACE, to keep the object
        -- identity (interactive warehouse cache) and its grants.
        INSERT OVERWRITE INTO FLEET_REQUEST_COST
            (SURFACE, REQUEST_ID, AGENT_FQN, TS_UTC, SERVICE_TYPE, MODEL,
             CREDITS_INPUT, CREDITS_OUTPUT, CREDITS_CACHE_READ, CREDITS_CACHE_WRITE)
        WITH src AS (
            SELECT
                'cortex_agent'   AS surface,
                REQUEST_ID, AGENT_DATABASE_NAME, AGENT_SCHEMA_NAME, AGENT_NAME,
                START_TIME, CREDITS_GRANULAR
            FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
            UNION ALL
            -- Not optional: the Cortex Agent view explicitly excludes CoWork.
            SELECT
                'cowork',
                REQUEST_ID, AGENT_DATABASE_NAME, AGENT_SCHEMA_NAME, AGENT_NAME,
                START_TIME, CREDITS_GRANULAR
            FROM SNOWFLAKE.ACCOUNT_USAGE.SNOWFLAKE_COWORK_USAGE_HISTORY
        )
        SELECT
            s.surface,
            -- The ROW-level REQUEST_ID is the join key to FLEET_TURNS. The
            -- request_id keys nested INSIDE CREDITS_GRANULAR are child tool calls
            -- (up to 9 per row) and do not correspond to a turn - joining on those
            -- would lose the turn linkage entirely.
            s.REQUEST_ID,
            s.AGENT_DATABASE_NAME || '.' || s.AGENT_SCHEMA_NAME || '.' || s.AGENT_NAME,
            -- START_TIME is TIMESTAMP_LTZ; turns are TIMESTAMP_NTZ in UTC. Without
            -- this conversion every window would be skewed by the session offset.
            CONVERT_TIMEZONE('UTC', s.START_TIME)::TIMESTAMP_NTZ,
            svc.key,
            mdl.key,
            -- COALESCE is load-bearing. 185 of 500 model objects omit
            -- cache_read_input, and one NULL term makes an entire additive
            -- expression NULL - which silently DROPS the row from a SUM. That
            -- produced a phantom 5.2% shortfall against TOKEN_CREDITS during
            -- grounding before it was caught.
            SUM(COALESCE(mdl.value:"input"::FLOAT, 0)),
            SUM(COALESCE(mdl.value:"output"::FLOAT, 0)),
            SUM(COALESCE(mdl.value:"cache_read_input"::FLOAT, 0)),
            SUM(COALESCE(mdl.value:"cache_write_input"::FLOAT, 0))
        FROM src s,
             LATERAL FLATTEN(INPUT => s.CREDITS_GRANULAR) el,
             LATERAL FLATTEN(INPUT => el.value)  req,
             LATERAL FLATTEN(INPUT => req.value) svc,
             LATERAL FLATTEN(INPUT => svc.value) mdl
        -- start_time is a SIBLING of service_type inside the request_id object, not
        -- a service. Unfiltered it flattens into a bogus service_type row.
        WHERE svc.key != 'start_time'
        GROUP BY 1, 2, 3, 4, 5, 6;

        SELECT COUNT(*) INTO n_cost FROM FLEET_REQUEST_COST;
    EXCEPTION
        WHEN OTHER THEN
            -- Leave n_cost NULL so FLEET_REFRESH_LOG records that cost did not
            -- refresh. A NULL N_COST is the signal to check the task owner's
            -- grants; every other table in this run is still valid.
            n_cost := NULL;
    END;

    -- 3k. Counts + refresh log, so the UI can show a real "last updated".
    SELECT COUNT(*) INTO n_agents   FROM FLEET_AGENT_INVENTORY;
    SELECT COUNT(*) INTO n_turns    FROM FLEET_TURNS;
    SELECT COUNT(*) INTO n_spans    FROM FLEET_SPANS;
    SELECT COUNT(*) INTO n_tokens   FROM FLEET_TOKENS;
    SELECT COUNT(*) INTO n_search   FROM FLEET_SEARCH_REQUESTS;
    SELECT COUNT(*) INTO n_feedback FROM FLEET_FEEDBACK;

    CREATE TABLE IF NOT EXISTS FLEET_REFRESH_LOG (
        REFRESHED_AT   TIMESTAMP_NTZ,
        N_AGENTS       INT,
        N_TURNS        INT,
        N_SPANS        INT,
        N_TOKENS       INT,
        N_SEARCH       INT,
        N_FEEDBACK     INT,
        N_COST         INT,
        DURATION_MS    NUMBER
    );
    -- Reshapes a log table created before N_COST existed. The DDL above is
    -- IF NOT EXISTS, so on an existing install it is a no-op and would otherwise
    -- leave the INSERT below failing on an unknown column.
    ALTER TABLE FLEET_REFRESH_LOG ADD COLUMN IF NOT EXISTS N_COST INT;

    INSERT INTO FLEET_REFRESH_LOG
        (REFRESHED_AT, N_AGENTS, N_TURNS, N_SPANS, N_TOKENS, N_SEARCH, N_FEEDBACK, N_COST, DURATION_MS)
    SELECT SYSDATE(), :n_agents, :n_turns, :n_spans, :n_tokens, :n_search, :n_feedback, :n_cost, NULL;

    RETURN 'OK agents=' || :n_agents || ' turns=' || :n_turns || ' spans=' || :n_spans
           || ' tokens=' || :n_tokens || ' search=' || :n_search || ' feedback=' || :n_feedback
           || ' cost=' || COALESCE(:n_cost::STRING, 'FAILED(check task owner grants)');
END;
$$;

/* =============================================================================
   STEP 3 — least-privilege application role and grants.

   Mirrors GROUNDING.md section 6, re-pointed to this schema and warehouses.
   Applied BEFORE the initial refresh so the FUTURE-table grant covers the
   derived tables the procedure is about to create on this very run.
   ============================================================================= */
CREATE ROLE IF NOT EXISTS FLEET_APP_ROLE
    COMMENT = 'Owning/serving role for the Cortex Agent Fleet Intelligence app.';

-- Account-level observability the app surfaces (held implicitly by ACCOUNTADMIN).
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER              TO ROLE FLEET_APP_ROLE;
GRANT DATABASE ROLE SNOWFLAKE.GOVERNANCE_VIEWER         TO ROLE FLEET_APP_ROLE;
GRANT APPLICATION ROLE SNOWFLAKE.AI_OBSERVABILITY_READER TO ROLE FLEET_APP_ROLE;

-- The materialized data layer.
GRANT USAGE  ON DATABASE FLEET_INTELLIGENCE                            TO ROLE FLEET_APP_ROLE;
GRANT USAGE  ON SCHEMA   FLEET_INTELLIGENCE.OBSERVABILITY              TO ROLE FLEET_APP_ROLE;
GRANT SELECT ON ALL    TABLES IN SCHEMA FLEET_INTELLIGENCE.OBSERVABILITY TO ROLE FLEET_APP_ROLE;
-- ON ALL is point-in-time; FUTURE covers the derived tables the procedure
-- creates on this run and re-creates via INSERT OVERWRITE every refresh.
GRANT SELECT ON FUTURE TABLES IN SCHEMA FLEET_INTELLIGENCE.OBSERVABILITY TO ROLE FLEET_APP_ROLE;
-- Threshold editing writes to FLEET_CONFIG.
GRANT INSERT, UPDATE ON TABLE FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_CONFIG TO ROLE FLEET_APP_ROLE;

-- Standard warehouse now; interactive warehouse is granted in STEP 6 once created.
GRANT USAGE ON WAREHOUSE FLEET_INTELLIGENCE_WH TO ROLE FLEET_APP_ROLE;

-- Let an admin assign the role (to the SAR service, or to yourself at deploy).
GRANT ROLE FLEET_APP_ROLE TO ROLE ACCOUNTADMIN;
-- GRANT ROLE FLEET_APP_ROLE TO USER <your_user>;

/* =============================================================================
   STEP 4 — initial data load.

   Populates the derived tables so the app has data immediately and so the
   interactive warehouse (STEP 6) has real table objects to cache. Runs on the
   standard warehouse — CALL is not supported on an interactive warehouse.

   The task owner (whoever runs THIS script) must be ACCOUNTADMIN or
   ACCOUNT_BUDGET_ADMIN for the cost step to read the metering views; otherwise
   FLEET_REQUEST_COST stays empty (N_COST = NULL in FLEET_REFRESH_LOG) and the
   cost card shows a dash. Everything else refreshes regardless.
   ============================================================================= */
USE WAREHOUSE FLEET_INTELLIGENCE_WH;
CALL FLEET_INTELLIGENCE.OBSERVABILITY.REFRESH_FLEET_OBSERVABILITY();

/* =============================================================================
   STEP 5 — serverless refresh task (every 10 minutes).

   Serverless (no WAREHOUSE clause) so the refresh never waits on a resume, and
   because CALL is unsupported on the interactive warehouse. Owned by whoever
   runs this script — keep it ACCOUNTADMIN/ACCOUNT_BUDGET_ADMIN so the cost step
   keeps working; do NOT re-own it to FLEET_APP_ROLE.
   ============================================================================= */
CREATE OR REPLACE TASK FLEET_INTELLIGENCE.OBSERVABILITY.REFRESH_FLEET_OBSERVABILITY_TASK
    SCHEDULE = '10 MINUTE'
    USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
    SUSPEND_TASK_AFTER_NUM_FAILURES = 0
    COMMENT = 'Refreshes Cortex Agent Fleet Intelligence derived tables every 10 minutes (serverless).'
AS
    CALL FLEET_INTELLIGENCE.OBSERVABILITY.REFRESH_FLEET_OBSERVABILITY();

ALTER TASK FLEET_INTELLIGENCE.OBSERVABILITY.REFRESH_FLEET_OBSERVABILITY_TASK RESUME;

/* =============================================================================
   STEP 6 — OPTIONAL: dedicated interactive warehouse (low-latency reads).

   Interactive warehouses are edition-gated. If `CREATE INTERACTIVE WAREHOUSE`
   errors in your account, SKIP THIS ENTIRE STEP and set the app's
   FLEET_READ_WAREHOUSE = FLEET_INTELLIGENCE_WH — the standard warehouse serves
   reads fine, just ~4x slower (GROUNDING.md section 4b). Everything above
   already gives you a fully working app; this is a performance upgrade only.

   Measured gain on the reference account: p50 252ms -> 58ms, p95 769ms -> 224ms.
   Cost: min AUTO_SUSPEND is 24h and the app polls every 10 min, so it never
   idles out while open (~14 credits/day). Use `npm run wh:suspend` when idle.
   ============================================================================= */
CREATE INTERACTIVE WAREHOUSE IF NOT EXISTS FLEET_INTELLIGENCE_IWH
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND   = 86400          -- 24h: the documented minimum for INTERACTIVE
    AUTO_RESUME    = TRUE
    COMMENT = 'Low-latency reads for Fleet Intelligence. Zero-copy over FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_*. READS ONLY - CALL and MERGE are unsupported on interactive warehouses.';

ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH SET FALLBACK_WAREHOUSE = FLEET_INTELLIGENCE_WH;

-- Tables must already exist (STEP 4 created them) — the cache list is keyed on
-- object identity, so a name that resolves to nothing is silently not registered.
ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH ADD TABLES (
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_TURNS,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_SPANS,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_TOKENS,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_FEEDBACK,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_SEARCH_REQUESTS,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_AGENT_INVENTORY,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_REQUEST_COST,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_CONFIG,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_RATE_LIMITS,
    FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_REFRESH_LOG
);

GRANT USAGE ON WAREHOUSE FLEET_INTELLIGENCE_IWH TO ROLE FLEET_APP_ROLE;

/* =============================================================================
   STEP 7 — verification.
   ============================================================================= */
-- Row counts from the run you just did. N_COST NULL => task owner lacks the
-- cost-view grants (see STEP 4); every other column should be non-NULL.
SELECT * FROM FLEET_INTELLIGENCE.OBSERVABILITY.FLEET_REFRESH_LOG
ORDER BY REFRESHED_AT DESC LIMIT 5;

-- Expect: state = started, schedule = 10 MINUTE, warehouse = null (serverless).
SHOW TASKS LIKE 'REFRESH_FLEET_OBSERVABILITY_TASK' IN SCHEMA FLEET_INTELLIGENCE.OBSERVABILITY;

/* =============================================================================
   NEXT: deploy the app (see README.md -> "Deploy from scratch")
     export NEXT_PUBLIC_FLEET_SCHEMA=FLEET_INTELLIGENCE.OBSERVABILITY
     snow app deploy --verbose
     snow app open
   Set FLEET_READ_WAREHOUSE / FLEET_WRITE_WAREHOUSE in app.yml if your warehouse
   names differ from the defaults.
   ============================================================================= */
