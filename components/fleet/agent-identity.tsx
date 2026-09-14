"use client";

import { fmtNum } from "@/lib/echarts";

/**
 * Agent identity banner. Answers "what am I actually looking at" before any
 * number on the page is read.
 *
 * ENTRANCE uses the `animate-fadeup` keyframe from globals.css (0.32s on
 * --ease-instrument), deliberately NOT motion/react. Two reasons:
 *  - it is the app's own declared entrance animation and was, until now, defined
 *    but unused;
 *  - being CSS, it is covered by the `prefers-reduced-motion` guard in
 *    globals.css. The one existing motion/react usage animates inline styles via
 *    JS and bypasses that guard entirely.
 *
 * The caller must key this on the agent FQN so React remounts it on agent change
 * and the entrance replays. Without a key, switching agents swaps the text with
 * no transition at all.
 *
 * IDENTITY COLOUR IS DERIVED, NOT READ FROM profile_color. Verified against this
 * account: `profile_color` is NULL for 8 of 10 agents, and the two populated
 * values are bare CSS colour names ("red", "blue") rather than hex. Bare `red` is
 * #ff0000, which collides with --color-st-critical (#ff5a5f) and would make an
 * ordinary agent look like it was alarming. globals.css is explicit that hue is
 * reserved for status and that data series use the achromatic-leaning ds-* ramp,
 * so the spine takes a stable colour hashed from the FQN off that ramp instead.
 * The declared profile colour is still shown, as a labelled chip, because it is
 * real metadata - it just does not drive the chrome.
 */

/** The ds-* data-series ramp from globals.css. Never the status hues. */
const IDENTITY_RAMP = ["#7ad7f0", "#4fb8c9", "#c8b88a", "#d98c6a", "#8e9bb0", "#5f7d95"];

/**
 * Stable colour per agent. A plain sum of char codes is enough here: the input is
 * a fully-qualified name, the output space is 6, and the only requirement is that
 * the same agent always gets the same colour across reloads.
 */
function identityColor(fqn: string): string {
  let h = 0;
  for (let i = 0; i < fqn.length; i++) h = (h + fqn.charCodeAt(i)) % 4096;
  return IDENTITY_RAMP[h % IDENTITY_RAMP.length];
}

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export type AgentIdentity = {
  agentFqn: string | null;
  displayName: string | null;
  agentName: string | null;
  database: string | null;
  schema: string | null;
  owner: string | null;
  profileColor: string | null;
  turnsTotal: number;
  distinctUsers: number;
  lastTurnTs: string | null;
};

export function AgentIdentityBanner({
  identity,
  agentFqn,
}: {
  identity: AgentIdentity | null;
  /** Falls back to the URL value so a stale deep link still names what it asked for. */
  agentFqn: string;
}) {
  // The URL can name an agent that has since been dropped. Say so plainly rather
  // than rendering an empty banner that looks like a loading state.
  if (!identity) {
    return (
      <div className="panel animate-fadeup flex items-center gap-3 px-3 py-2.5">
        <span className="h-9 w-[3px] shrink-0 bg-st-off" />
        <div className="min-w-0">
          <div className="truncate font-display text-[15px] leading-tight text-ink">
            Unknown agent
          </div>
          <div className="truncate font-mono text-[10px] text-ink-faint">{agentFqn}</div>
        </div>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-st-degraded">
          not in SHOW AGENTS
        </span>
      </div>
    );
  }

  const hue = identityColor(identity.agentFqn ?? agentFqn);

  return (
    <div className="panel animate-fadeup relative flex items-center gap-3 overflow-hidden px-3 py-2.5">
      {/* Identity spine. Same 3px + glow treatment as the feedback ribbon, but
          tinted by identity rather than status. */}
      <span
        className="h-9 w-[3px] shrink-0"
        style={{ background: hue, boxShadow: `0 0 10px -1px ${hue}` }}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h1
            className="truncate font-display text-[15px] leading-tight tracking-wide text-ink-hi"
            title={identity.displayName ?? ""}
          >
            {identity.displayName ?? identity.agentName ?? "—"}
          </h1>
          {/* The agent's own declared colour, shown as metadata only. */}
          {identity.profileColor && (
            <span
              className="shrink-0 rounded-chip border px-1.5 py-[1px] font-mono text-[9px]"
              style={{ borderColor: `${hue}55`, color: hue, background: `${hue}12` }}
              title="profile.color declared on the agent object"
            >
              {identity.profileColor}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-ink-faint" title={agentFqn}>
          {identity.agentFqn ?? agentFqn}
        </div>
      </div>

      {/* Facts that describe the agent itself, NOT the selected window - these come
          from SHOW AGENTS and lifetime activity, so they do not move with the
          window selector. The KPI row below is the windowed view. */}
      <dl className="hidden shrink-0 gap-x-5 font-mono text-[10px] sm:flex">
        <Fact label="owner" value={identity.owner ?? "—"} />
        <Fact label="users" value={String(identity.distinctUsers)} />
        <Fact label="turns" value={fmtNum(identity.turnsTotal)} hint="lifetime, all windows" />
        <Fact label="last seen" value={relTime(identity.lastTurnTs)} />
      </dl>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <dt className="label-micro text-[9px]">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
