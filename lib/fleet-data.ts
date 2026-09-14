import { querySnowflake } from "@/lib/snowflake";

/**
 * The Snowflake Node driver returns TIMESTAMP_LTZ / NTZ / TZ as JS `Date`
 * objects, not strings. `String(date)` yields "Tue Jun 03 2026 ..." so
 * `.slice(0, 10)` produces "Tue Jun 03" and any lexical sort silently inverts
 * chronological order. Every timestamp is therefore normalised to ISO at the
 * API boundary, before it can reach a chart axis or a sort comparator.
 */
export function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string") {
    const d = new Date(v.includes("T") || v.includes("Z") ? v : v.replace(" ", "T") + "Z");
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return null;
}

const TS_HINT = /(_TS|_AT|^TS$|TIMESTAMP|_SEEN|_TIME)/i;

/** Coerce a Snowflake value into a JSON-safe primitive. */
function normalizeValue(key: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return toIso(v);
  // Snowflake NUMBER can arrive as a string to preserve precision.
  if (typeof v === "string" && TS_HINT.test(key)) {
    const iso = toIso(v);
    if (iso) return iso;
  }
  if (typeof v === "object") return v; // VARIANT / ARRAY passes through
  return v;
}

export type Row = Record<string, unknown>;

/**
 * Bind values this app actually uses: agent FQNs, trace ids, and config
 * key/value strings. Narrowed rather than `unknown[]` so it satisfies the
 * driver's `Binds` type without a cast.
 */
export type FleetBind = string | number | boolean | null;

/**
 * Warehouse routing.
 *
 * Reads go to a dedicated INTERACTIVE warehouse (FLEET_INTELLIGENCE_IWH) for
 * low-latency dashboard queries. Writes must NOT: interactive warehouses reject
 * MERGE outright with "Cannot run statement type 'MERGE' on an interactive
 * warehouse", and FALLBACK_WAREHOUSE does not help because fallback only covers
 * the 5-second timeout, not unsupported statement types.
 *
 * Both are overridable by env var so a SAR deployment can point at whatever
 * warehouses that account has. Leaving READ_WAREHOUSE unset falls back to the
 * connection default, which keeps local dev working without any setup.
 */
const READ_WAREHOUSE = process.env.FLEET_READ_WAREHOUSE || "FLEET_INTELLIGENCE_IWH";
const WRITE_WAREHOUSE = process.env.FLEET_WRITE_WAREHOUSE || undefined;

/**
 * Run a read query and normalise every cell. Column keys arrive UPPERCASE.
 *
 * Routed to the interactive warehouse via QUERY_WAREHOUSE_NAME, which the
 * driver sets as a statement parameter - no `USE WAREHOUSE` round-trip, so the
 * connection pool stays shared with the write path.
 */
export async function fleetQuery(sql: string, binds?: FleetBind[]): Promise<Row[]> {
  return runQuery(sql, READ_WAREHOUSE, binds);
}

/**
 * Run a write (DML) query. Deliberately NOT routed to the interactive
 * warehouse - see the note above. Uses the connection default unless
 * FLEET_WRITE_WAREHOUSE is set.
 */
export async function fleetWrite(sql: string, binds?: FleetBind[]): Promise<Row[]> {
  return runQuery(sql, WRITE_WAREHOUSE, binds);
}

async function runQuery(
  sql: string,
  warehouse: string | undefined,
  binds?: FleetBind[],
): Promise<Row[]> {
  const rows = await querySnowflake(sql, {
    ...(warehouse ? { warehouse } : {}),
    ...(binds ? { binds } : {}),
  });
  return rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) out[k] = normalizeValue(k, v);
    return out;
  });
}

/** Numeric coercion that tolerates Snowflake's string-encoded numbers. */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Nullable numeric: preserves the difference between 0 and "no data". */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Parse a VARIANT array that may arrive as a JSON string or a real array. */
export function arr(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || t === "null") return [];
    try {
      const p = JSON.parse(t);
      return Array.isArray(p) ? p.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Typed config accessors over the FLEET_CONFIG key/value rows. */
export type FleetConfig = {
  greenMinutes: number;
  yellowHours: number;
  redHours: number;
  redIncludesTool: boolean;
  defaultWindow: string;
  excludeEvalRuns: boolean;
  warnPct: number;
  pagePct: number;
  usdPerAiCredit: number;
  raw: Record<string, string>;
};

export function parseConfig(rows: Row[]): FleetConfig {
  const raw: Record<string, string> = {};
  for (const r of rows) {
    const k = str(r.CONFIG_KEY);
    const v = str(r.CONFIG_VALUE);
    if (k !== null && v !== null) raw[k] = v;
  }
  const int = (k: string, d: number) => {
    const n = Number(raw[k]);
    return Number.isFinite(n) ? Math.trunc(n) : d;
  };
  const bool = (k: string, d: boolean) =>
    raw[k] === undefined ? d : raw[k].toLowerCase() === "true";
  // Cost rate is fractional, so it needs a float parser rather than `int`.
  // Guarded against <= 0: a zero rate would silently render every cost as $0.00,
  // which reads as "nothing was spent" rather than "the rate is misconfigured".
  const float = (k: string, d: number) => {
    const n = Number(raw[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };

  return {
    greenMinutes: int("hex.green_minutes", 60),
    yellowHours: int("hex.yellow_hours", 24),
    redHours: int("hex.red_hours", 24),
    redIncludesTool: bool("hex.red_includes_tool", false),
    defaultWindow: raw["kpi.default_window"] ?? "24h",
    excludeEvalRuns: bool("fleet.exclude_eval_runs", true),
    warnPct: int("sat.warn_pct", 60),
    pagePct: int("sat.page_pct", 80),
    // 2.00 = global inference routing, 2.20 = regional. Every row in this account
    // that carries inference_region reports 'global'.
    usdPerAiCredit: float("cost.usd_per_ai_credit", 2.0),
    raw,
  };
}
