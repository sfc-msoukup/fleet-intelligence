"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

/* ============================================================================
   Hand-rolled SVG hex grid.

   Why SVG and not CSS clip-path (which is the obvious modern answer):
   - clip-path DELETES the element's own box-shadow rather than clipping it, so
     an outer glow is impossible.
   - filter: drop-shadow() does not rescue it, because filters resolve BEFORE
     the clip, so the rectangular shadow is cut away too.
   - You cannot stroke a clip-path shape; the usual ::before inset trick yields
     a fill gap, not a 1px hairline.

   SVG gives all three things the design needs natively:
   - a true 1px hairline at any container size via vectorEffect
   - real multi-layer bloom via feGaussianBlur + feMerge, keeping a crisp core
     stroke AND a soft halo (stacked CSS drop-shadows re-blur the core)
   - free responsiveness from viewBox, with no resize observer

   Two traps, both handled below:
   - the default filter region clips a wide blur to a straight edge, so the
     region is expanded and the svg is overflow-visible
   - SVG filter ids are DOCUMENT-GLOBAL, so they are namespaced with useId()
   ========================================================================= */

const S = 10; // circumradius in viewBox units
const W = Math.sqrt(3) * S; // flat-to-flat width
const HALF_W = W / 2;

const HEX_PATH = [
  `M 0 ${-S}`,
  `L ${HALF_W} ${-S / 2}`,
  `L ${HALF_W} ${S / 2}`,
  `L 0 ${S}`,
  `L ${-HALF_W} ${S / 2}`,
  `L ${-HALF_W} ${-S / 2}`,
  "Z",
].join(" ");

const PAINT: Record<
  string,
  { hue: string; fill: number; live: boolean; from: number; to: number }
> = {
  NOMINAL: { hue: "#2fd8a6", fill: 0.14, live: true, from: 0.22, to: 0.5 },
  IDLE: { hue: "#93c5fd", fill: 0.16, live: true, from: 0.18, to: 0.42 },
  CRITICAL: { hue: "#ff5a5f", fill: 0.22, live: true, from: 0.5, to: 1 },
  OFF: { hue: "#5a6675", fill: 0.06, live: false, from: 0, to: 0 },
};

export type HexAgent = {
  agentFqn: string;
  agentName: string;
  displayName: string;
  state: string;
  turnsTotal: number;
  distinctUsers: number;
  lastTurnTs: string | null;
  lastSuccessTs: string | null;
  lastRequestErrorTs: string | null;
  lastToolErrorTs: string | null;
  minutesSinceLastTurn: number | null;
  owner: string | null;
};

/** Row-packed comb layout. Reads better than a spiral at fleet sizes. */
function layout(n: number): Array<{ q: number; r: number }> {
  const perRow = n <= 4 ? n : n <= 12 ? 4 : n <= 24 ? 6 : 8;
  const out: Array<{ q: number; r: number }> = [];
  let i = 0;
  let row = 0;
  while (i < n) {
    const count = Math.min(perRow - (row % 2), n - i);
    const offset = (row % 2) * 0.5;
    for (let c = 0; c < count; c++) {
      out.push({ q: c + offset - (count - 1) / 2, r: row });
      i++;
    }
    row++;
  }
  return out;
}

function ago(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "never";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function HexFleet({ agents }: { agents: HexAgent[] }) {
  const router = useRouter();
  const [hover, setHover] = useState<HexAgent | null>(null);
  // Namespaced: SVG filter ids are document-global, so a second instance of
  // this component would otherwise silently steal the first one's filters.
  const uid = useId().replace(/[:]/g, "");
  const softId = `hexsoft-${uid}`;
  const hardId = `hexhard-${uid}`;

  const pts = useMemo(() => {
    const coords = layout(agents.length);
    return agents.map((a, i) => {
      const { q, r } = coords[i] ?? { q: 0, r: 0 };
      return { ...a, x: W * (q + r / 2), y: ((S * 3) / 2) * r };
    });
  }, [agents]);

  if (agents.length === 0) {
    return (
      <div className="grid h-[280px] place-items-center border border-dashed border-line-faint">
        <span className="label-micro">No agents found in this account</span>
      </div>
    );
  }

  const pad = S * 2.4;
  const minX = Math.min(...pts.map((p) => p.x)) - pad;
  const maxX = Math.max(...pts.map((p) => p.x)) + pad;
  const minY = Math.min(...pts.map((p) => p.y)) - pad;
  const maxY = Math.max(...pts.map((p) => p.y)) + pad;

  // Cap the rendered width so tiles stay a legible instrument size instead of
  // scaling to fill an arbitrarily wide panel. ~92px per tile column reads best.
  const cols = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
  const maxWidthPx = Math.min(760, Math.max(340, ((cols + pad * 2) / W) * 96));

  return (
    <div className="relative">
      <div className="mx-auto" style={{ maxWidth: `${maxWidthPx}px` }}>
      <svg
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        className="h-auto w-full select-none overflow-visible"
        role="group"
        aria-label="Agent fleet status"
      >
        <defs>
          {/* Wide region: without it a broad halo gets a straight-edge clip. */}
          <filter
            id={softId}
            x="-75%"
            y="-75%"
            width="250%"
            height="250%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation="2.4" result="halo" />
            <feMerge>
              <feMergeNode in="halo" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter
            id={hardId}
            x="-120%"
            y="-120%"
            width="340%"
            height="340%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation="1.1" result="inner" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="4.2" result="outer" />
            <feMerge>
              <feMergeNode in="outer" />
              <feMergeNode in="inner" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {pts.map((a) => {
          const p = PAINT[a.state] ?? PAINT.OFF;
          const isHover = hover?.agentFqn === a.agentFqn;
          return (
            <g
              key={a.agentFqn}
              transform={`translate(${a.x} ${a.y})`}
              className="cursor-pointer focus-visible:outline-none"
              tabIndex={0}
              role="button"
              aria-label={`${a.displayName} — ${a.state}, ${a.turnsTotal} turns`}
              onMouseEnter={() => setHover(a)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(a)}
              onBlur={() => setHover(null)}
              onClick={() => router.push(`/agents?agent=${encodeURIComponent(a.agentFqn)}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(`/agents?agent=${encodeURIComponent(a.agentFqn)}`);
                }
              }}
            >
              <title>{`${a.displayName} — ${a.state}`}</title>

              {/* 1: breathing bloom. CSS keyframes, not JS - N tiles on rAF in
                  React is a frame budget not worth spending, and a compositor
                  opacity animation is free. */}
              {p.live && (
                <path
                  d={HEX_PATH}
                  fill="none"
                  stroke={p.hue}
                  strokeWidth={1.4}
                  filter={`url(#${a.state === "CRITICAL" ? hardId : softId})`}
                  className="animate-breathe motion-reduce:animate-none"
                  style={
                    {
                      "--breathe-from": p.from,
                      "--breathe-to": p.to,
                    } as React.CSSProperties
                  }
                />
              )}

              {/* 2: tonal fill - body, not decoration */}
              <path d={HEX_PATH} fill={p.hue} fillOpacity={p.fill} />

              {/* 3: the hairline. non-scaling-stroke keeps it exactly 1px. */}
              <path
                d={HEX_PATH}
                fill="none"
                stroke={p.hue}
                strokeWidth={1}
                strokeOpacity={isHover ? 1 : 0.55}
                vectorEffect="non-scaling-stroke"
                className="transition-[stroke-opacity] duration-200"
              />

              {/* 4: hover bezel - concentric inset reads as machined */}
              {isHover && (
                <path
                  d={HEX_PATH}
                  transform="scale(0.82)"
                  fill="none"
                  stroke={p.hue}
                  strokeWidth={1}
                  strokeOpacity={0.7}
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {/* 5: label + turn count. Font sized so 8 mono chars fit inside
                  the flat-to-flat width (17.32 units) without spilling. */}
              <text
                y={-0.8}
                textAnchor="middle"
                className="pointer-events-none fill-[#e6edf5] font-mono"
                style={{ fontSize: 2.15, letterSpacing: "-0.01em" }}
              >
                {a.agentName.replace(/_AGENT$/, "").slice(0, 8).toUpperCase()}
              </text>
              <text
                y={3.1}
                textAnchor="middle"
                className="pointer-events-none font-mono"
                style={{ fontSize: 2.5, fill: p.hue, opacity: 0.9 }}
              >
                {a.turnsTotal}
              </text>
            </g>
          );
        })}
      </svg>
      </div>

      {/* hover detail: a fixed slot rather than a floating tooltip, so the
          layout never shifts and the value is always in the same place */}
      <div className="mt-2 flex min-h-[46px] items-start gap-4 border-t border-line-faint pt-2">
        {hover ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[12px] tracking-wide text-ink-hi">
                {hover.displayName}
              </div>
              <div className="truncate font-mono text-[10px] text-ink-faint">
                {hover.agentFqn}
              </div>
            </div>
            <dl className="flex shrink-0 gap-4 font-mono text-[10px]">
              <div>
                <dt className="label-micro">State</dt>
                <dd
                  style={{ color: (PAINT[hover.state] ?? PAINT.OFF).hue }}
                  className="mt-0.5"
                >
                  {hover.state}
                </dd>
              </div>
              <div>
                <dt className="label-micro">Turns</dt>
                <dd className="mt-0.5 text-ink">{hover.turnsTotal}</dd>
              </div>
              <div>
                <dt className="label-micro">Users</dt>
                <dd className="mt-0.5 text-ink">{hover.distinctUsers}</dd>
              </div>
              <div>
                <dt className="label-micro">Last</dt>
                <dd className="mt-0.5 text-ink">{ago(hover.minutesSinceLastTurn)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <span className="label-micro pt-1">
            Hover a tile for detail · click to open the agent
          </span>
        )}
      </div>
    </div>
  );
}
