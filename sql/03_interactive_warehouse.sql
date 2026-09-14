/* =============================================================================
   Cortex Agent Fleet Intelligence - dedicated interactive warehouse
   Object: FLEET_INTELLIGENCE_IWH  (INTERACTIVE, XSMALL, zero-copy)

   WHY INTERACTIVE, AND WHY XSMALL
   Measured on 1,817 real dashboard queries against DEMO_WH (X-Small standard)
   over a 2-day window:

       p50 total      189 ms
       p95 total      740 ms
       max total    2,586 ms
       p50 compile    161 ms   <-- 85% of the latency
       p50 execute     22 ms
       max scanned   1.13 MB
       over 5 s           0

   Execution is already trivial; compile and dispatch dominate. The entire
   fleet data set is 1.32 MB across 10 tables, so a larger warehouse would
   multiply credits for no latency win - the interactive skill's own sizing
   rule puts anything under 350 GB of working set at XSMALL. The gain here is
   removing per-query compile/dispatch overhead and tightening the 4x p50->p95
   spread, which is what actually makes a dashboard feel slow.

   WHY ZERO-COPY AND NOT INTERACTIVE TABLES
   REFRESH_FLEET_OBSERVABILITY rebuilds every FLEET_* table every 10 minutes.
   Interactive tables would add a second refresh layer chasing tables that are
   already being replaced wholesale, and at 1.32 MB there is no clustering
   benefit to chase. Zero-copy needs no change to the pipeline.

   THREE CONSTRAINTS FOUND BY TESTING, NOT BY READING DOCS
   1. CALL is not supported on an interactive warehouse. REFRESH_FLEET_OBSERVABILITY
      must keep running on the serverless task - never route it here.
   2. MERGE is rejected outright: "Cannot run statement type 'MERGE' on an
      interactive warehouse." The app's /api/config write path uses MERGE, so
      reads go here and writes go to a standard warehouse. FALLBACK_WAREHOUSE
      does NOT rescue this - fallback only covers the 5-second timeout, not
      unsupported statement types.
   3. The proactive cache list is keyed on OBJECT IDENTITY, not name. When the
      refresh used CREATE OR REPLACE TABLE, the list silently went from 9 tables
      to 3 within one refresh cycle and queries kept working, so nothing looked
      broken. sql/01_data_layer.sql now uses INSERT OVERWRITE for exactly this
      reason. Verified stable across repeated refreshes (9 -> 9 -> 9).

   COST - READ THIS BEFORE LEAVING IT RUNNING
   The minimum AUTO_SUSPEND for an interactive warehouse is 86400 s (24 h), and
   the dashboard polls every 10 minutes, so it will never idle out while the app
   is open. Measured from INTERACTIVE_LOAD_WH in this account: ~0.58 credits/hour
   while running, i.e. ~14 credits/day. DEMO_WH currently burns ~1.1 credits/day
   for ALL demo activity in the account. Use sql/04_warehouse_suspend.sql (or
   `npm run wh:suspend`) when you are done demoing.
   ============================================================================= */

USE DATABASE SNOWFLAKE_INTELLIGENCE;
USE SCHEMA AGENTS;

/* -----------------------------------------------------------------------------
   1. The warehouse.

      CREATE IF NOT EXISTS rather than OR REPLACE: replacing it would discard
      the cache association and any grants, which is the same class of bug that
      the data layer had. To resize, use the ALTER below instead.
   -------------------------------------------------------------------------- */
CREATE INTERACTIVE WAREHOUSE IF NOT EXISTS FLEET_INTELLIGENCE_IWH
    WAREHOUSE_SIZE = 'XSMALL'
    AUTO_SUSPEND   = 86400          -- 24 h: the documented minimum for INTERACTIVE
    AUTO_RESUME    = TRUE
    COMMENT        = 'Dedicated low-latency warehouse for the Cortex Agent Fleet Intelligence dashboard. Zero-copy over SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_*. READS ONLY - CALL and MERGE are unsupported on interactive warehouses.';

-- Idempotent re-assertion, so re-running this file repairs drift.
ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH SET
    WAREHOUSE_SIZE = 'XSMALL',
    AUTO_SUSPEND   = 86400,
    AUTO_RESUME    = TRUE;

/* -----------------------------------------------------------------------------
   2. Fallback for the 5-second timeout.

      DEMO_WH is X-Small standard - equal size is permitted, and it costs
      nothing unless a query actually exceeds 5 s. Nothing does today (slowest
      is 2.6 s), so this is insurance against a data-volume regression.

      NOTE: the target is NOT validated when set. Both a self-reference and a
      nonexistent warehouse name were accepted without error in testing, which
      means a typo here silently disables fallback protection. Verify with the
      SHOW PARAMETERS query in section 5 - it is the only way to confirm, since
      SHOW WAREHOUSES does not expose this field.
   -------------------------------------------------------------------------- */
ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH SET FALLBACK_WAREHOUSE = DEMO_WH;

/* -----------------------------------------------------------------------------
   3. Proactive caching for all ten fleet tables.

      Tables not listed here are still queryable - they just cache on demand.
      Listing them tells Snowflake to keep them warm.

      The table must already EXIST before it can be added: this list is keyed on
      object identity, so a name that resolves to nothing is not registered.
      FLEET_REQUEST_COST is created by sql/01_data_layer.sql section 2b, so run
      that file before this one.
   -------------------------------------------------------------------------- */
ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH ADD TABLES (
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_TURNS,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_SPANS,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_TOKENS,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_FEEDBACK,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_SEARCH_REQUESTS,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_AGENT_INVENTORY,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_REQUEST_COST,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_CONFIG,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_RATE_LIMITS,
    SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_REFRESH_LOG
);

/* -----------------------------------------------------------------------------
   4. Grants for App Runtime deployment.

      The app's owning role needs USAGE on both warehouses: the interactive one
      for reads and the standard one for the config MERGE. Replace the role name
      when the SAR service role is known.
   -------------------------------------------------------------------------- */
-- GRANT USAGE ON WAREHOUSE FLEET_INTELLIGENCE_IWH TO ROLE <app_role>;
-- GRANT USAGE ON WAREHOUSE DEMO_WH                TO ROLE <app_role>;

/* -----------------------------------------------------------------------------
   5. Verification.
   -------------------------------------------------------------------------- */
SHOW WAREHOUSES LIKE 'FLEET_INTELLIGENCE_IWH';
-- Expect: type=INTERACTIVE, size=X-Small, auto_suspend=86400, and the `tables`
-- column listing all 10 FLEET_* tables.

SHOW PARAMETERS IN WAREHOUSE FLEET_INTELLIGENCE_IWH;
-- Expect: FALLBACK_WAREHOUSE = DEMO_WH. This is the ONLY place the fallback is
-- observable; SHOW WAREHOUSES omits it.
