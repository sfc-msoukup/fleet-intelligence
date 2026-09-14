"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The info affordance shared by every metric tile.
 *
 * Two tiers, on purpose:
 * - `hint` alone renders a native `title` tooltip. Cheap, and correct for a
 *   one-line caveat. 20-odd call sites across the app still use exactly this.
 * - `description` and/or `sql` upgrade it to a click-to-open popover, which a
 *   `title` attribute cannot do: it strips newlines in several browsers,
 *   guarantees no monospace, and cannot be selected or copied - all fatal for
 *   showing a query. When the popover is used `hint` is not discarded, it moves
 *   to a footnote so no existing wording is lost.
 *
 * Extracted from KpiCard rather than duplicated because the Error Rate tile is
 * hand-rolled (it renders two values side by side, so it cannot be a KpiCard)
 * and still needs the identical affordance. One implementation, two callers.
 *
 * The caller owns positioning: this renders a `relative` wrapper and anchors the
 * panel to it, so the caller must not clip it with `overflow-hidden`.
 */
export function MetricInfo({
  label,
  hint,
  description,
  sql,
  align = "left",
}: {
  /** Metric name, shown as the popover heading and in the aria-label. */
  label: string;
  hint?: string;
  /** Plain-language definition of the metric. Promotes the icon to a popover. */
  description?: string;
  /** Copy-pasteable SQL that produces this metric. Promotes the icon to a popover. */
  sql?: string;
  /**
   * Which edge the panel is anchored to. It is ~30rem wide, so a tile in the
   * right half of a 4-column grid must anchor right or the panel overflows the
   * viewport and forces horizontal scroll.
   */
  align?: "left" | "right";
}) {
  const hasPopover = Boolean(description || sql);

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dismiss on outside click and on Escape. Listeners attach only while open, so
  // a page full of closed tiles adds no global handlers.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  async function copySql() {
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard is unavailable outside a secure context. The SQL is selectable
      // in the <pre>, so failing quietly beats an alarming error state.
    }
  }

  if (!hasPopover) {
    return hint ? (
      <span className="cursor-help font-mono text-[10px] text-ink-faint" title={hint}>
        ⓘ
      </span>
    ) : null;
  }

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`How ${label} is calculated`}
        className={`font-mono text-[10px] leading-none transition-colors ${
          open ? "text-st-info" : "text-ink-faint hover:text-ink-lo"
        }`}
      >
        ⓘ
      </button>

      {open && (
        <div
          className={`absolute top-full z-30 mt-2 w-[min(30rem,88vw)] rounded-panel border border-line-strong bg-raised p-3 text-left shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="label-micro mb-1.5 text-ink">{label}</div>

          {description && (
            <p className="mb-2.5 font-mono text-[11px] leading-relaxed text-ink">{description}</p>
          )}

          {sql && (
            <>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="label-micro text-ink-faint">Calculated as</span>
                <button
                  type="button"
                  onClick={copySql}
                  className="rounded-chip border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-lo transition-colors hover:border-line-strong hover:text-ink"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-chip border border-line bg-inset p-2 font-mono text-[10px] leading-relaxed text-ink-hi">
                {sql}
              </pre>
            </>
          )}

          {hint && (
            <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-ink-faint">{hint}</p>
          )}
        </div>
      )}
    </span>
  );
}
