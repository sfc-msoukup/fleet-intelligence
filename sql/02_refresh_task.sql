/* =============================================================================
   Serverless task: refresh fleet observability every 10 minutes.

   Serverless (no WAREHOUSE clause) per the chosen approach, so the refresh
   never waits on a warehouse resume and costs only for what it uses.

   Note: the task owner's role executes the procedure, and the procedure is
   EXECUTE AS CALLER. The owning role therefore needs the same grants the app
   needs: SNOWFLAKE.USAGE_VIEWER, SNOWFLAKE.GOVERNANCE_VIEWER, and the
   SNOWFLAKE.AI_OBSERVABILITY_READER application role.
   ============================================================================= */

USE DATABASE SNOWFLAKE_INTELLIGENCE;
USE SCHEMA AGENTS;

CREATE OR REPLACE TASK REFRESH_FLEET_OBSERVABILITY_TASK
    SCHEDULE = '10 MINUTE'
    USER_TASK_MANAGED_INITIAL_WAREHOUSE_SIZE = 'XSMALL'
    SUSPEND_TASK_AFTER_NUM_FAILURES = 0
    COMMENT = 'Refreshes Cortex Agent Fleet Intelligence derived tables every 10 minutes (serverless).'
AS
    CALL SNOWFLAKE_INTELLIGENCE.AGENTS.REFRESH_FLEET_OBSERVABILITY();

ALTER TASK REFRESH_FLEET_OBSERVABILITY_TASK RESUME;
