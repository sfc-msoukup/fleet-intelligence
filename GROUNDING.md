# Grounding & Deployment

## 1. Metric provenance

Every number the app renders traces to one of four sources. Nothing is estimated,
assumed, or carried in from outside this Snowflake account.

| Source | What comes from it | How it is read |
| --- | --- | --- |
| `SNOWFLAKE.LOCAL.AI_OBSERVABILITY_EVENTS` | agent turns, spans, tokens, feedback, search requests | flat real-time view, filtered to `object.type = 'CORTEX AGENT'` |
| `SNOWFLAKE.ACCOUNT_USAGE.CORTEX_REST_API_RATE_LIMIT_POLICIES` | per-model TPM and RPM ceilings | refreshed every run into `FLEET_RATE_LIMITS` with `SOURCE = 'account_view'` |
| `SHOW AGENTS IN ACCOUNT` | agent inventory, display name, profile colour, owner | so zero-traffic agents still appear on the hex panel |
| Named limits | Agent API 500 RPM, Search 20 QPS / service, 140 QPS / account | seeded with explicit `SOURCE` provenance, surfaced in the UI as a badge |

The Agent API cap carries `SOURCE = 'internal_verified'` rather than
`public_docs`, and the UI badge reads `INTERNAL`, because it is verified from
internal guidance and is not currently in the public rate-limit documentation.
It is modelled as a first-class ceiling, not a constant in application code.

### Derived from the starter SQL

`sql/01_data_layer.sql` is built directly on the span and feedback parsing in
`3.1.1 Snowflake_Agent_Usage_Monitoring.sql`. Reconciliation against the raw
view:

| Metric | Raw source | Derived table | Match |
| --- | --- | --- | --- |
| agent turns | 321 root `AgentV2RequestResponseInfo` spans | `FLEET_TURNS` = 321 | exact |
| agent spans | 4,029 | `FLEET_SPANS` = 4,029 | exact |
| LLM spans | 1,349 | `FLEET_TOKENS` = 1,349 | exact |
| total tokens | 35,333,805 | 35,333,805 | exact |
| feedback events | 13 | `FLEET_FEEDBACK` = 13 | exact |
| search requests | 62,038 | `FLEET_SEARCH_REQUESTS` = 62,038 | exact |
| agents | 10 | `FLEET_AGENT_INVENTORY` = 10 | exact |
| model limit rows | 30 | `FLEET_RATE_LIMITS` = 30 | exact |

Two changes were made to the starter logic, both because the account data
contradicted the original assumption:

1. **Token source.** `CORTEX_AGENT_REQUEST.token_count.*` is populated on only
   65 of 321 turns, while `agent.planning.token_count.*` is populated on 100% of
   LLM spans *and* carries `agent.planning.model`. The planning-span approach in
   the starter SQL is therefore the complete one, and is what drives every token
   metric. This is the source of the `7502 != 10875` discrepancy noted in the
   original file.
2. **Resource-name parsing.** The starter SQL used two different `SUBSTR` forms
   for extracting resource names from span names; both are normalised to
   `SUBSTR(span_name, POSITION('_' IN span_name) + 1)`.

## 2. Findings that changed the metrics

These were discovered during validation and each one would have produced wrong
numbers if missed.

- **`object.type` casing.** Occurs as both `'Cortex Agent'` and `'CORTEX AGENT'`
  in this account. Compared with `UPPER()`; a case-sensitive filter silently
  halves the fleet.
- **UTC.** The event timestamps are `TIMESTAMP_NTZ` in UTC while
  `CURRENT_TIMESTAMP` is session-local (UTC-7 here). All windowing uses
  `SYSDATE()`. Using `CURRENT_TIMESTAMP` would have shifted every window by 7
  hours and rendered the whole hex panel grey.
- **Token categories overlap.** Verified on all 1,349 LLM spans:
  `total = input + output`, and `cache_read + cache_write` are **subsets of**
  `input`. Stacking the five reported categories flat sums to 71.7M against a
  real total of 35.3M. The chart stacks
  `cache_read + cache_write + fresh_input + output`, which reconciles exactly,
  and shows `plan_tokens` on a separate axis because it is not additive.
- **Cache hit rate denominator.** Because `cache_read ⊆ input`, the hit rate is
  `cache_read / input`. Treating them as disjoint reported 43% where the true
  figure is 77%.
- **Two different error rates.** The root span reports `status.code` 200 on all
  321 turns, so request-level failure surfaces only via `status.description`.
  Tool-level failures occur inside otherwise successful turns. These are
  reported separately and never blended.
- **Negative span durations.** `UserMemoryInjection` emits start after end on
  100% of rows (-60s to -13s) and root `Agent` spans on 10 of 321 (clock skew).
  These are nulled and flagged, not clamped to zero, so they drop out of
  percentiles instead of understating real work. The waterfall states how many
  spans it omitted.
- **Eval-harness traffic.** `run.name` marks real agent turns driven by an
  evaluation run — 78 of 311. These are retained with `IS_EVAL_RUN = TRUE` and
  excluded by a visible, configurable toggle rather than silently dropped.
- **QPS requires per-second buckets.** Minute-bucketing the real incident in
  this account averaged a 409 QPS peak down to ~7. Account-wide QPS sums across
  services *within* each second and then takes the max; max-per-service-then-sum
  overstates the peak.
- **Grain fanout.** Joining request-grain to second-grain without aggregating
  first reported 48.7M search requests instead of 62,038 — a 786x inflation.
  Every saturation query aggregates each grain separately before joining.

## 3. Coverage limits

Stated in the UI rather than hidden:

- **Cortex Search QPS** is only observable for services with
  `REQUEST_LOGGING = TRUE`. All 7 services in this account have been enabled,
  but only services that have actually served traffic since enablement appear.
  Services with no rows are absent rather than shown as zero.
- **Per-model TPM/RPM** ceilings are consumed by *all* inference in the account,
  not only agent traffic. Agent usage is reported as a share of the ceiling, and
  the page says so.
- **Feedback categories** are a free-form string array with no documented
  enumeration. They are discovered at query time; a hardcoded enum would drop
  unrecognised values. Negative feedback with no category at all is surfaced as
  its own number instead of being folded into "Other".
- **History depth is shorter than the longest window.** Windows run
  60m / 24h / 7d / 30d / 90d / 180d / 365d, but the event view currently retains
  **176 days** of agent turns (earliest `2026-03-20`) and only **23 days** of
  Cortex Search requests (`2026-08-20` onward, since request logging was enabled
  later). So 180d and 365d return identical results today. Rather than hide the
  longer windows, `/api/fleet` returns a `coverage` block
  (`turnHistoryDays`, `earliestTurnTs`, `windowExceedsHistory`) and the window
  selector marks any window that reaches past retained history with an asterisk
  plus a tooltip. A long window is never silently presented as full coverage.

### Window buckets

Trend granularity is declared per window in `WINDOWS` (`lib/fleet-sql.ts`), not
derived from the window length, because it is chosen for chart legibility — the
aim is 24-90 points. Daily buckets over a year would be 365 bars in a ~600px
panel.

| Window | Trend bucket | Points on current data |
| --- | --- | --- |
| 60m | minute | 0 |
| 24h | hour | 1 |
| 7d | day | 1 |
| 30d | day | 3 |
| 90d | day | 13 |
| 180d | week | 17 |
| 365d | week | 17 (history-capped) |

**Saturation queries deliberately ignore this bucket** and always aggregate at
the limit's own granularity — per MINUTE for TPM/RPM, per SECOND for Search QPS
(correctness rule 4). Widening the window must never coarsen a ceiling check, or
a breach averages away. `scripts/verify.py` asserts this for all three long
windows, along with `peak >= p50` per model and request-count monotonicity across
nested windows.

Long windows change conclusions materially on this account: request error rate
reads **0% at 30d but 8.7% at 90d**, and 5 of 10 agents return no data at all at
30d versus all 10 at 90d+. The default window remains 24h for live triage; the
long windows exist for trend and regression work.

## 4. Refresh architecture

```
SNOWFLAKE.LOCAL.AI_OBSERVABILITY_EVENTS   (real-time, ~106k rows)
                │
                ▼
REFRESH_FLEET_OBSERVABILITY()             full rebuild via INSERT OVERWRITE, ~16s
                │
                ▼
FLEET_TURNS / FLEET_SPANS / FLEET_TOKENS / FLEET_FEEDBACK
FLEET_SEARCH_REQUESTS / FLEET_AGENT_INVENTORY / FLEET_RATE_LIMITS
                │
                ▼
REFRESH_FLEET_OBSERVABILITY_TASK          serverless, SCHEDULE = '10 MINUTE'
                │
                ▼
FLEET_INTELLIGENCE_IWH                    interactive XSMALL, zero-copy (reads)
                │
                ▼
Next.js API routes → TanStack Query (refetchInterval 600s)
```

Three independent clocks/indicators, all shown in the status strip:

- **Pipeline** — age of the materialised tables, from `FLEET_REFRESH_LOG`. Turns
  amber past 25 minutes, which means the task is failing.
- **Next** — countdown to the next browser refetch, derived from
  `dataUpdatedAt`.
- **Interactive / Standard** — which warehouse served the read, from
  `CURRENT_WAREHOUSE()`. Amber when reads are *not* on the interactive
  warehouse, because the app still works on a standard one, just ~4x slower —
  so a routing regression would otherwise be invisible.

Full rebuild rather than incremental merge: the source is small, and a full
rebuild cannot drift. Serverless so the refresh never waits on a warehouse
resume — and it must stay that way, because `CALL` is not supported on an
interactive warehouse.

## 4b. Interactive warehouse

`FLEET_INTELLIGENCE_IWH` — INTERACTIVE, XSMALL, zero-copy over the nine
`FLEET_*` tables. Created by `sql/03_interactive_warehouse.sql`.

### Why XSMALL, measured not guessed

Baseline across 1,817 real dashboard queries on DEMO_WH (X-Small standard):

| Metric | Value |
| --- | --- |
| p50 / p95 / max | 189ms / 740ms / 2,586ms |
| p50 compile vs execute | **161ms compile / 22ms execute** |
| Max bytes scanned | 1.13 MB |
| Queries over 5s | 0 |

Total fleet data is 1.29 MB. Execution was already trivial; compile and dispatch
were ~85% of latency. A larger warehouse multiplies credits for no latency gain,
so XSMALL is the correct size and scaling up would be waste.

### Measured result

Same queries, same hour, standard vs interactive:

| Metric | DEMO_WH (standard) | FLEET_INTELLIGENCE_IWH | Gain |
| --- | --- | --- | --- |
| p50 | 252ms | **58ms** | 4.3x |
| p95 | 769ms | **224ms** | 3.4x |
| max | 2,308ms | **573ms** | 4.0x |
| p50 compile | 211ms | **50ms** | 4.2x |
| p50 execute | 31ms | **9ms** | 3.4x |
| failures | 0 | 0 | — |

Everything is now sub-second including the worst case, against a 5s guardrail.

### Three constraints found by testing

1. **`CALL` is not supported.** `REFRESH_FLEET_OBSERVABILITY` must stay on the
   serverless task and must never be routed here.
2. **`MERGE` is rejected outright** — `Cannot run statement type 'MERGE' on an
   interactive warehouse`. The `/api/config` write path uses `MERGE`, so
   `lib/fleet-data.ts` splits `fleetQuery` (reads → interactive) from
   `fleetWrite` (DML → standard). `FALLBACK_WAREHOUSE` does **not** rescue this:
   fallback covers only the 5-second timeout, not unsupported statement types.
3. **The proactive cache list is keyed on object identity, not name.** This was
   the important one. With `CREATE OR REPLACE TABLE` in the refresh, the list
   went from **9 tables to 3 in a single refresh cycle** — and the three
   survivors were exactly the tables built with `MERGE`/`DELETE+INSERT`. Queries
   still succeeded, so nothing looked broken; the dashboard just silently
   stopped being cached ten minutes after setup.

   The same defect also dropped **grants** (`CREATE OR REPLACE TABLE` discards
   privileges unless `COPY GRANTS` is given), which would have broken the App
   Runtime deployment on every refresh. Both are fixed by building into a
   TEMPORARY staging table and loading with `CREATE TABLE IF NOT EXISTS ... LIKE`
   + `INSERT OVERWRITE`, which replaces all rows while keeping the object.
   Verified stable across repeated refreshes (9 → 9 → 9).

   Trade-off: the persistent table is only created when absent, so changing a
   table's column list will not reshape it — `INSERT OVERWRITE` fails loudly on a
   column mismatch. After a schema change, `DROP` that `FLEET_*` table once and
   re-run `sql/01_data_layer.sql`.

### Two gotchas worth knowing

- **`FALLBACK_WAREHOUSE` is not validated when set.** Both a self-reference and
  a nonexistent warehouse name were accepted without error, so a typo silently
  disables fallback protection. It is also **not** exposed by
  `SHOW WAREHOUSES` — `SHOW PARAMETERS IN WAREHOUSE` is the only way to confirm.
- **`CREATE WAREHOUSE` makes it the session's current warehouse.** After
  creating it, unrelated ad-hoc queries in that session inherit the 5-second
  timeout and start failing. Run `USE WAREHOUSE <standard>` before analytics.

### Cost

The minimum `AUTO_SUSPEND` for an interactive warehouse is **86400s (24h)**, and
the dashboard polls every 10 minutes, so it never idles out while the app is
open. Measured from `INTERACTIVE_LOAD_WH` in this account: **~0.58 credits/hour**
running ≈ **14 credits/day**. DEMO_WH burns ~1.1 credits/day for *all* demo
activity, so this is roughly a 13x increase in dashboard compute cost.

Control it with:

```bash
npm run wh:suspend   # done demoing
npm run wh:resume    # before a demo, absorbs resume delay up front
npm run wh:status
```

Verify the task:

```sql
SHOW TASKS LIKE 'REFRESH_FLEET_OBSERVABILITY_TASK' IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS;
-- expect: state = started, schedule = 10 MINUTE, warehouse = null (serverless)

SELECT * FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY(
  TASK_NAME => 'REFRESH_FLEET_OBSERVABILITY_TASK')) ORDER BY SCHEDULED_TIME DESC LIMIT 10;

SELECT * FROM SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_REFRESH_LOG ORDER BY REFRESHED_AT DESC LIMIT 5;
```

## 5. Running locally

```bash
SNOWFLAKE_DEFAULT_CONNECTION_NAME=<YOUR_CONNECTION> npm run dev
```

Connection resolution order in `lib/snowflake.ts`: SPCS OAuth token →
environment variables → `~/.snowflake/connections.toml`. Locally it uses the
TOML path.

Note the `<YOUR_CONNECTION>` connection specifies `database = DEMO_DB`,
`schema = DEMO_SCHEMA`, and `DEMO_SCHEMA` does not exist. `snow connection test`
therefore fails on `USE SCHEMA`, but the app is unaffected because every query is
fully qualified. `REFRESH_FLEET_OBSERVABILITY` also pins its own schema for the
same reason.

Verification scripts:

```bash
python3 scripts/verify.py         # pages, all four APIs, config allowlist
python3 scripts/verify_tokens.py  # token arithmetic reconciliation
```

## 6. Deploying to Snowflake App Runtime

Not yet deployed — currently local only, as requested.

```bash
snow app setup                       # writes app.yml v2 (requires CLI >= 3.26)
snow app deploy --verbose            # build + push + create APPLICATION SERVICE
snow app open
```

`app.yml.template-build` is the template's build-only manifest, moved aside so
`snow app setup` can generate the real one. Use `/opt/anaconda3/bin/snow`
(3.27.0) — a bare `snow` resolves to a root-owned 3.15.0 bundle at
`/Applications/SnowflakeCLI.app` that wins on PATH and does not support SAR.

### Grants the app's owning role needs

The app reads account-level observability, which `ACCOUNTADMIN` currently holds
implicitly. An app service role needs these explicitly:

```sql
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER      TO ROLE <app_role>;
GRANT DATABASE ROLE SNOWFLAKE.GOVERNANCE_VIEWER TO ROLE <app_role>;
GRANT APPLICATION ROLE SNOWFLAKE.AI_OBSERVABILITY_READER TO ROLE <app_role>;

GRANT USAGE ON DATABASE SNOWFLAKE_INTELLIGENCE TO ROLE <app_role>;
GRANT USAGE ON SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE <app_role>;
GRANT SELECT ON ALL TABLES IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE <app_role>;
-- ON ALL is a point-in-time snapshot: it does NOT cover tables created later, and
-- this schema had no FUTURE grants (verified: SHOW FUTURE GRANTS returned nothing,
-- and FLEET_TURNS carried only OWNERSHIP). Without this line the next FLEET_* table
-- added to the refresh is invisible to the app and its panel 500s.
GRANT SELECT ON FUTURE TABLES IN SCHEMA SNOWFLAKE_INTELLIGENCE.AGENTS TO ROLE <app_role>;
-- threshold editing writes to FLEET_CONFIG
GRANT INSERT, UPDATE ON TABLE SNOWFLAKE_INTELLIGENCE.AGENTS.FLEET_CONFIG TO ROLE <app_role>;

-- Both warehouses: the interactive one serves reads, the standard one serves the
-- FLEET_CONFIG MERGE (MERGE is rejected on an interactive warehouse).
GRANT USAGE ON WAREHOUSE FLEET_INTELLIGENCE_IWH TO ROLE <app_role>;
GRANT USAGE ON WAREHOUSE DEMO_WH                TO ROLE <app_role>;
```

Because the derived tables are now loaded with `INSERT OVERWRITE` instead of
`CREATE OR REPLACE`, these `SELECT` grants survive the 10-minute refresh. Under
the previous pattern they were dropped on every cycle.

### The task owner needs MORE than the app role

`REFRESH_FLEET_OBSERVABILITY` is `EXECUTE AS CALLER`, so the **task owner's** role
does all the source reading. It needs the observability grants above **plus**
`SELECT` on the two cost-metering views, and those are **not** covered by
`SNOWFLAKE.USAGE_VIEWER`.

Verified with `SHOW GRANTS ON VIEW` against this account. Both
`SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY` and
`SNOWFLAKE.ACCOUNT_USAGE.SNOWFLAKE_COWORK_USAGE_HISTORY` grant `SELECT` to exactly
two roles:

| grantee | privilege |
| --- | --- |
| `ACCOUNTADMIN` | SELECT |
| `ACCOUNT_BUDGET_ADMIN` | SELECT |

`USAGE_VIEWER` is absent from both. So the task must be owned by `ACCOUNTADMIN` or
`ACCOUNT_BUDGET_ADMIN` (it is `ACCOUNTADMIN` today), or those views must be granted
explicitly by an account admin.

The app role does **not** need them: the app never queries `ACCOUNT_USAGE`, it reads
the materialized `FLEET_REQUEST_COST` table. The privilege requirement lands on the
refresh path only.

If the task is ever re-owned to a role without that access, step 3k fails. It is
wrapped in its own `EXCEPTION` handler so the other nine tables still refresh, and
`FLEET_REFRESH_LOG.N_COST` goes NULL to make it visible rather than silent.

### Deployment notes

- Fonts are self-hosted at build time by `next/font/google`, so there is no
  runtime CDN dependency. If build-time egress is restricted, swap the three
  `next/font/google` calls for `next/font/local` and vendor the `.woff2` files —
  nothing else reads the fonts directly, only the CSS variables.
- `next.config.mjs` pins `turbopack.root` and `outputFileTracingRoot` to
  `__dirname`. Do not remove these: Next 16 walks upward for a lockfile and
  silently re-roots the project if it finds one, which breaks chunk URLs and
  file tracing at deploy time.
- Serverless SAR apps do not support event-table health monitoring, so the
  in-app pipeline-age indicator is the health signal.
- Warehouse routing is env-overridable: `FLEET_READ_WAREHOUSE` (defaults to
  `FLEET_INTELLIGENCE_IWH`) and `FLEET_WRITE_WAREHOUSE` (defaults to the
  connection default). Set both at deploy time if the target account names its
  warehouses differently. `scripts/verify.py` asserts reads land on an
  interactive warehouse, so a misconfiguration fails verification rather than
  silently costing 4x latency.
