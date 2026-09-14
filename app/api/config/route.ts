import { fleetQuery, fleetWrite, parseConfig } from "@/lib/fleet-data";
import { Q_CONFIG, FLEET_SCHEMA, isWindowKey } from "@/lib/fleet-sql";

export const dynamic = "force-dynamic";

/**
 * Only these keys may be written, and each declares its own validator. This is
 * an allowlist rather than a passthrough so the endpoint cannot be used to
 * write arbitrary rows into FLEET_CONFIG.
 */
const WRITABLE: Record<string, (v: string) => boolean> = {
  "hex.green_minutes": (v) => /^\d{1,6}$/.test(v) && +v > 0,
  "hex.yellow_hours": (v) => /^\d{1,5}$/.test(v) && +v > 0,
  "hex.red_hours": (v) => /^\d{1,5}$/.test(v) && +v > 0,
  "hex.red_includes_tool": (v) => v === "true" || v === "false",
  // Validated against the shared window registry rather than a copy of the key
  // list, so adding a window cannot leave this endpoint rejecting it.
  "kpi.default_window": (v) => isWindowKey(v),
  "fleet.exclude_eval_runs": (v) => v === "true" || v === "false",
  "sat.warn_pct": (v) => /^\d{1,3}$/.test(v) && +v > 0 && +v <= 100,
  "sat.page_pct": (v) => /^\d{1,3}$/.test(v) && +v > 0 && +v <= 100,
};

export async function GET() {
  try {
    return Response.json({ config: parseConfig(await fleetQuery(Q_CONFIG)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const updates: Array<[string, string]> = [];

    for (const [k, v] of Object.entries(body)) {
      const validate = WRITABLE[k];
      if (!validate) {
        return Response.json({ error: `Key not writable: ${k}` }, { status: 400 });
      }
      const val = String(v);
      if (!validate(val)) {
        return Response.json({ error: `Invalid value for ${k}: ${val}` }, { status: 400 });
      }
      updates.push([k, val]);
    }

    if (updates.length === 0) {
      return Response.json({ error: "No updates supplied" }, { status: 400 });
    }

    // Bound parameters throughout; the key is validated against the allowlist
    // above and never concatenated into the statement.
    //
    // fleetWrite, not fleetQuery: MERGE is rejected on an interactive warehouse
    // ("Cannot run statement type 'MERGE' on an interactive warehouse"), and the
    // fallback warehouse does not cover unsupported statement types - only the
    // 5-second timeout. Reads stay on the interactive warehouse.
    for (const [k, v] of updates) {
      await fleetWrite(
        `MERGE INTO ${FLEET_SCHEMA}.FLEET_CONFIG t
         USING (SELECT ? AS k, ? AS v) s ON t.CONFIG_KEY = s.k
         WHEN MATCHED THEN UPDATE SET CONFIG_VALUE = s.v, UPDATED_AT = SYSDATE()
         WHEN NOT MATCHED THEN INSERT (CONFIG_KEY, CONFIG_VALUE, VALUE_TYPE)
              VALUES (s.k, s.v, 'STRING')`,
        [k, v],
      );
    }

    return Response.json({ config: parseConfig(await fleetQuery(Q_CONFIG)), updated: updates.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[api/config]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
