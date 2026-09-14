"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useFeedback } from "@/lib/hooks";
import { Chart, Panel } from "@/components/ui/chart";
import { AXIS, TOOLTIP, fmtNum, fmtPct } from "@/lib/echarts";

type Item = {
  recordId: string | null;
  agentFqn: string;
  agentName: string;
  ts: string | null;
  userName: string | null;
  roleName: string | null;
  isPositive: boolean;
  message: string | null;
  categories: string[];
  threadId: string | null;
};

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}Z`;
}

/**
 * Feedback ribbon. Collapsed it shows agent / user / timestamp; expanded it
 * reveals categories and the comment.
 *
 * The 3px status spine on the left is what makes a list of these scannable: at a
 * glance you see the negative/positive ratio down the page without reading a
 * single word.
 */
function Ribbon({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  const hue = item.isPositive ? "#2fd8a6" : "#ff5a5f";
  const hasDetail = Boolean(item.message) || item.categories.length > 0;

  return (
    <li className="border-b border-line-faint last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-raised/40"
      >
        {/* status spine */}
        <span
          className="h-7 w-[3px] shrink-0"
          style={{ background: hue, boxShadow: `0 0 8px -1px ${hue}` }}
        />

        <span
          className="w-4 shrink-0 text-center font-mono text-[11px]"
          style={{ color: hue }}
          aria-hidden
        >
          {item.isPositive ? "▲" : "▼"}
        </span>

        <span className="w-48 shrink-0">
          <span className="block truncate font-mono text-[12px] text-ink-hi">
            {item.agentName}
          </span>
          <span
            className="block truncate font-mono text-[10px] text-ink-faint"
            title={item.agentFqn}
          >
            {item.agentFqn}
          </span>
        </span>

        {/* inline comment preview - fills the row's dead space and lets the gist
            of each comment be read without expanding. Truncates to one line; the
            full text lives in the title on hover and in the expanded panel. */}
        <span
          className="min-w-0 flex-1 truncate font-sans text-[11px] text-ink-lo"
          title={item.message ?? undefined}
        >
          {item.message ?? <span className="text-ink-faint">—</span>}
        </span>

        <span className="hidden w-28 shrink-0 truncate font-mono text-[11px] text-ink sm:block">
          {item.userName ?? "—"}
        </span>

        <span className="hidden w-36 shrink-0 font-mono text-[10px] text-ink-lo md:block">
          {fmtTs(item.ts)}
        </span>

        {/* category count badge */}
        <span className="w-16 shrink-0 text-right font-mono text-[10px] text-ink-faint">
          {item.categories.length > 0
            ? `${item.categories.length} cat`
            : item.isPositive
              ? ""
              : "no cat"}
        </span>

        <span
          className={`shrink-0 font-mono text-[10px] text-ink-faint transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden
        >
          ›
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-line-faint bg-inset/50 px-3 py-2.5 pl-[34px]">
              {item.categories.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-1">
                  {item.categories.map((c) => (
                    <span
                      key={c}
                      className="rounded-chip border px-1.5 py-[2px] font-mono text-[10px]"
                      style={{
                        borderColor: `${hue}55`,
                        color: hue,
                        background: `${hue}12`,
                      }}
                    >
                      {c}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mb-2 font-mono text-[10px] text-ink-faint">
                  No categories submitted with this feedback.
                </div>
              )}

              {item.message ? (
                <p className="max-w-[100ch] font-sans text-[12px] leading-relaxed text-ink">
                  {item.message}
                </p>
              ) : (
                <p className="font-mono text-[10px] text-ink-faint">
                  No comment text submitted.
                </p>
              )}

              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 border-t border-line-faint pt-2 font-mono text-[10px]">
                <div className="flex gap-1.5">
                  <dt className="text-ink-faint">role</dt>
                  <dd className="text-ink">{item.roleName ?? "—"}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-ink-faint">thread</dt>
                  <dd className="text-ink">{item.threadId ?? "—"}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-ink-faint">record</dt>
                  <dd className="truncate text-ink" title={item.recordId ?? ""}>
                    {item.recordId?.slice(0, 18) ?? "—"}
                  </dd>
                </div>
                <Link
                  href={`/agents?agent=${encodeURIComponent(item.agentFqn)}`}
                  className="ml-auto text-st-info hover:underline"
                >
                  Open agent →
                </Link>
              </dl>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

export default function FeedbackPage() {
  const { data, error } = useFeedback();
  const [filter, setFilter] = useState<"all" | "negative" | "positive">("all");
  const [category, setCategory] = useState<string | null>(null);
  // null = every agent in the account (the default). A specific agent_fqn
  // rescopes the whole page - KPIs, both charts and the stream - to that agent.
  const [agent, setAgent] = useState<string | null>(null);

  const summary = data?.summary;
  const categories: Array<{ category: string; n: number; agents: number }> =
    data?.categories ?? [];
  const uncategorized: number = data?.uncategorizedNegative ?? 0;
  const byAgent: Array<{
    agentFqn: string;
    agentName: string;
    total: number;
    positive: number;
    negative: number;
  }> = data?.byAgent ?? [];
  const items: Item[] = data?.items ?? [];

  // Items scoped to the selected agent. `items` is the COMPLETE feedback table
  // (Q_FEEDBACK_ITEMS has no LIMIT), so when an agent is chosen every aggregate
  // below re-derives from it exactly, reproducing the server rollups.
  const scopedItems = useMemo(
    () => (agent ? items.filter((i) => i.agentFqn === agent) : items),
    [items, agent],
  );

  // With no agent selected the validated account-wide server aggregates pass
  // straight through; a specific agent rescopes each one from `scopedItems`.
  const effSummary = useMemo(() => {
    if (!agent) return summary;
    const total = scopedItems.length;
    const positive = scopedItems.filter((i) => i.isPositive).length;
    const users = new Set(scopedItems.map((i) => i.userName).filter(Boolean)).size;
    return { total, positive, negative: total - positive, agents: total > 0 ? 1 : 0, users };
  }, [agent, summary, scopedItems]);

  const effCategories = useMemo(() => {
    if (!agent) return categories;
    const counts = new Map<string, { n: number; agents: Set<string> }>();
    for (const i of scopedItems) {
      if (i.isPositive) continue;
      for (const c of i.categories) {
        const e = counts.get(c) ?? { n: 0, agents: new Set<string>() };
        e.n += 1;
        e.agents.add(i.agentFqn);
        counts.set(c, e);
      }
    }
    return [...counts.entries()]
      .map(([cat, e]) => ({ category: cat, n: e.n, agents: e.agents.size }))
      .sort((a, b) => b.n - a.n);
  }, [agent, categories, scopedItems]);

  const effUncategorized = useMemo(
    () =>
      agent
        ? scopedItems.filter((i) => !i.isPositive && i.categories.length === 0).length
        : uncategorized,
    [agent, uncategorized, scopedItems],
  );

  const effByAgent = useMemo(
    () => (agent ? byAgent.filter((a) => a.agentFqn === agent) : byAgent),
    [agent, byAgent],
  );

  const filtered = useMemo(() => {
    let out = scopedItems;
    if (filter === "negative") out = out.filter((i) => !i.isPositive);
    if (filter === "positive") out = out.filter((i) => i.isPositive);
    if (category) out = out.filter((i) => i.categories.includes(category));
    return out;
  }, [scopedItems, filter, category]);

  const negRate =
    effSummary && effSummary.total > 0
      ? (effSummary.negative / effSummary.total) * 100
      : null;

  /** Category breakdown for negative feedback. */
  const catOption = useMemo(() => {
    const rows = [...effCategories];
    if (effUncategorized > 0) {
      rows.push({ category: "(no category given)", n: effUncategorized, agents: 0 });
    }
    return {
      grid: { left: 168, right: 40, top: 6, bottom: 20 },
      tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value", ...AXIS, minInterval: 1 },
      yAxis: {
        type: "category",
        data: rows.map((c) => c.category),
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, width: 160, overflow: "truncate" },
      },
      series: [
        {
          type: "bar",
          data: rows.map((c) => ({
            value: c.n,
            itemStyle: {
              color: c.category === "(no category given)" ? "#48545f" : "#ff5a5f",
              opacity: c.category === "(no category given)" ? 0.5 : 0.85,
            },
          })),
          barMaxWidth: 16,
          label: {
            show: true,
            position: "right",
            color: "#6b7a8b",
            fontSize: 10,
            fontFamily: "var(--font-mono), monospace",
          },
        },
      ],
    };
  }, [effCategories, effUncategorized]);

  /** Positive vs negative per agent. */
  const agentOption = useMemo(
    () => ({
      grid: { left: 150, right: 24, top: 18, bottom: 20 },
      tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" } },
      legend: {
        top: -2,
        right: 0,
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: "#6b7a8b", fontSize: 9, fontFamily: "var(--font-mono), monospace" },
      },
      xAxis: { type: "value", ...AXIS, minInterval: 1 },
      yAxis: {
        type: "category",
        data: effByAgent.map((a: { agentName: string }) => a.agentName),
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, width: 140, overflow: "truncate" },
      },
      series: [
        {
          name: "Positive",
          type: "bar",
          stack: "f",
          data: effByAgent.map((a: { positive: number }) => a.positive),
          itemStyle: { color: "#2fd8a6" },
          barMaxWidth: 16,
        },
        {
          name: "Negative",
          type: "bar",
          stack: "f",
          data: effByAgent.map((a: { negative: number }) => a.negative),
          itemStyle: { color: "#ff5a5f" },
          barMaxWidth: 16,
        },
      ],
    }),
    [effByAgent],
  );

  if (error) {
    return (
      <div className="panel border-st-critical/40 p-4">
        <div className="label-micro mb-1 text-st-critical">Feedback query failed</div>
        <pre className="overflow-x-auto font-mono text-[11px] text-ink">{String(error)}</pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- agent filter ---------- */}
      {/* Governs the whole page: KPIs, both charts and the stream all rescope to
          the chosen agent. Sourced from the account-wide `byAgent` rollup so the
          full list is always present regardless of the current selection. */}
      <div className="panel flex flex-wrap items-center gap-1.5 px-3 py-2">
        <span className="label-micro mr-1">Agent</span>
        <button
          onClick={() => setAgent(null)}
          className={`rounded-chip border px-2 py-[3px] font-mono text-[11px] transition-colors ${
            agent === null
              ? "border-line-strong bg-raised text-ink-hi"
              : "border-line text-ink-lo hover:border-line-strong hover:text-ink"
          }`}
        >
          All agents
          {summary ? <span className="ml-1.5 text-ink-faint">{summary.total}</span> : null}
        </button>
        {byAgent.map((a) => (
          <button
            key={a.agentFqn}
            onClick={() => setAgent(a.agentFqn)}
            title={a.agentFqn}
            className={`rounded-chip border px-2 py-[3px] font-mono text-[11px] transition-colors ${
              agent === a.agentFqn
                ? "border-line-strong bg-raised text-ink-hi"
                : "border-line text-ink-lo hover:border-line-strong hover:text-ink"
            }`}
          >
            {a.agentName || a.agentFqn.split(".").pop()}
            <span className="ml-1.5 text-ink-faint">{a.total}</span>
          </button>
        ))}
      </div>

      {/* ---------- summary ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="panel px-3 py-2.5">
          <span className="label-micro">Total Feedback</span>
          <div className="mt-1 font-mono text-[26px] leading-none text-ink-hi" data-metric>
            {effSummary ? fmtNum(effSummary.total) : "—"}
          </div>
          <div className="mt-1 font-mono text-[10px] text-ink-faint">
            {effSummary?.agents ?? 0} agents · {effSummary?.users ?? 0} users
          </div>
        </div>

        <div className="panel px-3 py-2.5">
          <span className="label-micro">Positive</span>
          <div className="mt-1 font-mono text-[26px] leading-none text-st-nominal" data-metric>
            {effSummary ? fmtNum(effSummary.positive) : "—"}
          </div>
          <div className="mt-1 font-mono text-[10px] text-ink-faint">
            {effSummary && effSummary.total > 0
              ? fmtPct((effSummary.positive / effSummary.total) * 100, 0)
              : "—"}{" "}
            of all feedback
          </div>
        </div>

        <div className="panel px-3 py-2.5">
          <span className="label-micro">Negative</span>
          <div className="mt-1 font-mono text-[26px] leading-none text-st-critical" data-metric>
            {effSummary ? fmtNum(effSummary.negative) : "—"}
          </div>
          <div className="mt-1 font-mono text-[10px] text-ink-faint">
            {negRate !== null ? fmtPct(negRate, 0) : "—"} of all feedback
          </div>
        </div>

        <div className="panel px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="label-micro">Uncategorised</span>
            <span
              className="cursor-help font-mono text-[10px] text-ink-faint"
              title="Negative feedback submitted with no category array. These are the hardest items to action, so they are surfaced as a first-class number rather than hidden in an 'Other' bucket."
            >
              ⓘ
            </span>
          </div>
          <div className="mt-1 font-mono text-[26px] leading-none text-ink-hi" data-metric>
            {fmtNum(effUncategorized)}
          </div>
          <div className="mt-1 font-mono text-[10px] text-ink-faint">
            of {effSummary?.negative ?? 0} negative items
          </div>
        </div>
      </div>

      {/* ---------- breakdowns ---------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Negative feedback categories"
          hint="Categories are a free-form string array on the feedback event with no fixed vocabulary, so values are discovered from the data rather than mapped to a hardcoded enum. Click a bar to filter the list below."
          right={
            category && (
              <button
                onClick={() => setCategory(null)}
                className="rounded-chip border border-line px-1.5 py-[2px] font-mono text-[10px] text-ink-lo hover:text-ink"
              >
                clear filter
              </button>
            )
          }
        >
          <Chart
            option={catOption}
            height={Math.max(140, (effCategories.length + (effUncategorized > 0 ? 1 : 0)) * 26 + 40)}
            empty={effCategories.length === 0 && effUncategorized === 0}
            onEvents={{
              click: (p: unknown) => {
                const name = (p as { name?: string })?.name;
                if (!name || name === "(no category given)") return;
                setCategory(name === category ? null : name);
                setFilter("negative");
              },
            }}
          />
        </Panel>

        <Panel
          title="Feedback by agent"
          hint="Absolute counts, not rates. With single-digit volumes a percentage would imply precision the sample size does not support."
        >
          <Chart
            option={agentOption}
            height={Math.max(140, effByAgent.length * 28 + 46)}
            empty={effByAgent.length === 0}
          />
        </Panel>
      </div>

      {/* ---------- ribbons ---------- */}
      <Panel
        title="Feedback stream"
        hint="Each row expands to show the categories and comment submitted with it."
        pad={false}
        right={
          <div className="flex items-center gap-2">
            {category && (
              <span className="rounded-chip border border-st-critical/40 bg-st-critical/10 px-1.5 py-[2px] font-mono text-[10px] text-st-critical">
                {category}
              </span>
            )}
            <div className="flex overflow-hidden rounded-chip border border-line">
              {(
                [
                  ["negative", "NEGATIVE"],
                  ["positive", "POSITIVE"],
                  ["all", "ALL"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`px-2 py-[3px] font-mono text-[10px] transition-colors ${
                    filter === k
                      ? "bg-raised text-ink-hi"
                      : "text-ink-lo hover:bg-raised/50 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[10px] text-ink-faint">{filtered.length} shown</span>
          </div>
        }
      >
        {filtered.length === 0 ? (
          <div className="label-micro py-10 text-center">
            No feedback matches the current filter
          </div>
        ) : (
          <ul className="flex flex-col">
            {filtered.map((item, i) => (
              <Ribbon key={item.recordId ?? `${item.agentFqn}-${i}`} item={item} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
