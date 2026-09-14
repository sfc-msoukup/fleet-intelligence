/* =============================================================================
   Suspend the dashboard's interactive warehouse.

   Interactive warehouses cannot auto-suspend in under 24 hours, and the app
   polls every 10 minutes, so the warehouse stays up for as long as the
   dashboard is open. At ~0.58 credits/hour (measured on this account) that is
   ~14 credits/day. Run this when you are done demoing.

   Queries WILL fail while suspended. AUTO_RESUME = TRUE is set, so the next
   query restarts it automatically - expect a one-off resume delay on that
   first query.

   Usage:  snow sql -c <YOUR_CONNECTION> -f sql/04_warehouse_suspend.sql
       or: npm run wh:suspend
   ============================================================================= */

ALTER WAREHOUSE FLEET_INTELLIGENCE_IWH SUSPEND;

SHOW WAREHOUSES LIKE 'FLEET_INTELLIGENCE_IWH';
