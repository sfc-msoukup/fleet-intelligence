"use client";

import { useEffect, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useShell } from "@/components/console/console-shell";
import { useFleet } from "@/lib/hooks";
import { REFRESH_MS, APP_TITLE } from "@/lib/constants";
import { WINDOWS, WINDOW_KEYS } from "@/lib/fleet-sql";

// Abbreviated chip labels. Derived from the shared registry so a new window can
// never appear in the API but go missing from the selector; only the short label
// is local, because "365D" does not fit the chip as comfortably as "1Y".
const SHORT: Record<string, string> = {
  "60m": "60M",
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
  "180d": "180D",
  "365d": "1Y",
};

const WINDOW_CHIPS = WINDOW_KEYS.map((key) => ({
  key,
  label: SHORT[key] ?? WINDOWS[key].label,
}));

function fmtCountdown(ms: number) {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function StatusStrip({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { window: win, setWindow } = useShell();
  const q = useFleet(win);
  // isFetching (not isPending) so the indicator fires on every background poll,
  // not just the first load. Most of the "this is live" feeling is this detail.
  const fetching = useIsFetching() > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Countdown derived from dataUpdatedAt, which is when the poll timer last
  // restarted - the only correct source for "next refresh in".
  const updatedAt = q.dataUpdatedAt || 0;
  const remaining = updatedAt ? REFRESH_MS - (now - updatedAt) : REFRESH_MS;

  const refresh = q.data?.refresh;
  const dataAge = refresh?.ageSeconds;
  const stale = typeof dataAge === "number" && dataAge > 1500; // >25 min = task problem

  // History depth, used to warn on the chip when a window reaches past the
  // oldest retained event. Without this a 1Y selection looks identical to 180D
  // and silently implies a year of coverage that does not exist.
  const historyDays = q.data?.coverage?.turnHistoryDays ?? null;

  // Read-path warehouse. Matched on type rather than an exact name so a renamed
  // or per-environment warehouse still registers as the fast path.
  const servedBy = refresh?.servedBy ?? null;
  const onFastPath = !!servedBy && /IWH|INTERACTIVE/i.test(servedBy);

  return (
    <header className="relative flex items-center gap-4 border-b border-line bg-base/80 px-4 backdrop-blur-xl">
      {/* indeterminate hairline while any query is in flight */}
      {fetching && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
          <span className="block h-px w-full origin-left animate-scanbar bg-st-info" />
        </span>
      )}

      <div className="flex items-baseline gap-2">
        <span className="font-display text-[12px] font-600 tracking-[0.14em] uppercase text-ink-hi">
          {APP_TITLE}
        </span>
        <span className="label-micro hidden sm:inline">Cortex Agent Mission Control</span>
      </div>

      {/* window selector */}
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="label-micro mr-1 hidden lg:inline">Window</span>
          <div className="flex overflow-hidden rounded-chip border border-line">
            {WINDOW_CHIPS.map((w) => {
              // A window is only partially covered once it reaches past the
              // earliest retained turn. Marked rather than hidden: the data it
              // does show is real, it just is not the full span requested.
              const exceeds =
                typeof historyDays === "number" && WINDOWS[w.key].unit === "day"
                  ? WINDOWS[w.key].n > historyDays
                  : false;
              return (
                <button
                  key={w.key}
                  onClick={() => setWindow(w.key)}
                  title={
                    exceeds
                      ? `${WINDOWS[w.key].label} - only ${historyDays}d of history is retained, so this shows all available data`
                      : WINDOWS[w.key].label
                  }
                  className={`px-1.5 py-[3px] font-mono text-[11px] transition-colors duration-150 ${
                    win === w.key
                      ? "bg-raised text-ink-hi"
                      : "text-ink-lo hover:text-ink hover:bg-raised/50"
                  }`}
                >
                  {w.label}
                  {exceeds && <span className="ml-0.5 text-st-degraded">*</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* pipeline freshness: the age of the materialised tables, which is a
            different thing from when the browser last fetched them. Both shown. */}
        <div className="hidden items-center gap-1.5 lg:flex" title="Age of the materialised fleet tables (serverless task runs every 10 min)">
          <span
            className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-st-degraded" : "bg-st-nominal"}`}
            style={{ boxShadow: stale ? "0 0 6px #ffc53d" : "0 0 6px #2fd8a6" }}
          />
          <span className="label-micro">Pipeline</span>
          <span className="font-mono text-[11px] text-ink">
            {typeof dataAge === "number" && dataAge >= 0 ? `${Math.floor(dataAge / 60)}m` : "—"}
          </span>
        </div>

        {/* Which warehouse served the read. Amber when it is not the dedicated
            interactive warehouse, because the app stays fully functional on the
            standard one - just ~4x slower - so a routing regression is otherwise
            invisible. */}
        {servedBy && (
          <div
            className="hidden items-center gap-1.5 xl:flex"
            title={
              onFastPath
                ? `Reads served by ${servedBy} (interactive, sub-second)`
                : `Reads served by ${servedBy} — NOT the dedicated interactive warehouse. Expect ~4x higher latency.`
            }
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${onFastPath ? "bg-st-info" : "bg-st-degraded"}`}
              style={{ boxShadow: onFastPath ? "0 0 6px #4db8ff" : "0 0 6px #ffc53d" }}
            />
            <span className="label-micro">{onFastPath ? "Interactive" : "Standard"}</span>
          </div>
        )}

        <div className="flex items-center gap-1.5" title="Time until the next client refresh">
          <span className="label-micro hidden md:inline">Next</span>
          <span className="font-mono text-[11px] text-ink-hi tabular-nums">
            {fmtCountdown(remaining)}
          </span>
        </div>

        <button
          onClick={onOpenPalette}
          className="hidden items-center gap-1 rounded-chip border border-line px-1.5 py-[2px] font-mono text-[10px] text-ink-lo transition-colors hover:border-line-strong hover:text-ink xl:flex"
        >
          <span>⌘K</span>
        </button>
      </div>
    </header>
  );
}
