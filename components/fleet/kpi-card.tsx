"use client";

import NumberFlow, { type Format } from "@number-flow/react";
import type { ReactNode } from "react";
import { MetricInfo } from "@/components/fleet/metric-info";

/**
 * KPI tile. Deliberate choices:
 * - the metric stays in ink-hi and only the SUBVALUE carries colour. Colouring
 *   the value itself turns a quantity into a status indicator and destroys the
 *   hierarchy.
 * - NumberFlow animates digit-by-digit rather than counting through hundreds of
 *   values that were never true, and it is tabular-figure aware so the tile
 *   does not reflow.
 * - designed for "1,284,993,201" and for "—" from the start.
 *
 * The info affordance lives in MetricInfo, shared with the hand-rolled Error Rate
 * tile. See that file for the hint-vs-popover tiering.
 */
export function KpiCard({
  label,
  value,
  suffix,
  format,
  subvalue,
  subcolor,
  detail,
  hint,
  description,
  sql,
  infoAlign = "left",
  spark,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  /**
   * Number formatting for the metric. Defaults to a plain grouped number; pass
   * `{ style: "currency", currency: "USD" }` for a money tile so the symbol is
   * part of the animated value rather than a detached prefix.
   *
   * NumberFlow's own `Format` rather than `Intl.NumberFormatOptions`: it excludes
   * scientific and engineering notation, which it cannot animate.
   */
  format?: Format;
  subvalue?: string;
  subcolor?: string;
  detail?: ReactNode;
  hint?: string;
  /** Plain-language definition of the metric. Promotes the info icon to a popover. */
  description?: string;
  /** Copy-pasteable SQL that produces this metric. Promotes the icon to a popover. */
  sql?: string;
  /** Which edge the popover anchors to. See MetricInfo. */
  infoAlign?: "left" | "right";
  spark?: ReactNode;
}) {
  const hasValue = value !== null && Number.isFinite(value);

  return (
    // The card clips ONLY its bleed-to-edge sparkline (below), never the whole
    // panel: a panel-level overflow-hidden also clips the MetricInfo popover,
    // which must overflow the card to be readable (that was the regression). The
    // outer wrapper keeps h-full so cards in a grid row stay equal height.
    <div className="relative h-full">
      <div className="panel relative flex h-full flex-col gap-1 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="label-micro">{label}</span>
          <MetricInfo
            label={label}
            hint={hint}
            description={description}
            sql={sql}
            align={infoAlign}
          />
        </div>

        <div className="flex items-baseline gap-1" data-metric>
          {hasValue ? (
            <>
              <NumberFlow
                value={value as number}
                format={format ?? { notation: "standard", maximumFractionDigits: 2 }}
                className="font-mono text-[26px] leading-none font-500 text-ink-hi"
              />
              {suffix && (
                <span className="font-mono text-[13px] leading-none text-ink-lo">{suffix}</span>
              )}
            </>
          ) : (
            <span className="font-mono text-[26px] leading-none text-ink-faint">—</span>
          )}
        </div>

        {subvalue && (
          <div
            className="font-mono text-[10px] leading-tight"
            style={{ color: subcolor ?? "var(--color-ink-lo)" }}
          >
            {subvalue}
          </div>
        )}

        {detail && <div className="mt-0.5 font-mono text-[10px] text-ink-faint">{detail}</div>}

        {spark && (
          <div className="-mx-3 -mb-2.5 mt-1 h-[34px] overflow-hidden rounded-b-panel">{spark}</div>
        )}
      </div>
    </div>
  );
}
