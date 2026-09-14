/* =============================================================================
   Resume the dashboard's interactive warehouse.

   RESUME IF SUSPENDED is idempotent, so this is safe to run when the warehouse
   is already up. Run it before a demo to absorb the resume delay up front
   rather than on the first dashboard query.

   Usage:  snow sql -c <YOUR_CONNECTION> -f sql/05_warehouse_resume.sql
       or: npm run wh:resume
   ============================================================================= */

ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH RESUME IF SUSPENDED;

SHOW WAREHOUSES LIKE 'FLEET_INTELLIGENCE_IWH';
