"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FleetConfig } from "@/lib/fleet-data";

/**
 * Hex threshold editor. These are stored in FLEET_CONFIG rather than hardcoded,
 * so the definition of "healthy" is the operator's to set. The RED definition in
 * particular is a real judgement call: request-level errors alone are a much
 * narrower signal than including tool-level failures, and both are defensible.
 */
export function HexConfigPopover({
  config,
  onClose,
}: {
  config?: FleetConfig;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [green, setGreen] = useState(String(config?.greenMinutes ?? 60));
  const [yellow, setYellow] = useState(String(config?.yellowHours ?? 24));
  const [red, setRed] = useState(String(config?.redHours ?? 24));
  const [redTool, setRedTool] = useState(Boolean(config?.redIncludesTool));
  const [excludeEval, setExcludeEval] = useState(config?.excludeEvalRuns ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "hex.green_minutes": green,
          "hex.yellow_hours": yellow,
          "hex.red_hours": red,
          "hex.red_includes_tool": String(redTool),
          "fleet.exclude_eval_runs": String(excludeEval),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      await qc.invalidateQueries();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-panel border border-line-strong bg-raised/60 p-3">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Nominal within (min)" value={green} onChange={setGreen} />
        <Field label="Idle within (hr)" value={yellow} onChange={setYellow} />
        <Field label="Critical window (hr)" value={red} onChange={setRed} />

        <label className="flex cursor-pointer items-center gap-2 pb-1">
          <input
            type="checkbox"
            checked={redTool}
            onChange={(e) => setRedTool(e.target.checked)}
            className="h-3 w-3 accent-[#ff5a5f]"
          />
          <span className="font-mono text-[11px] text-ink">
            Critical includes tool failures
          </span>
        </label>

        <label className="flex cursor-pointer items-center gap-2 pb-1">
          <input
            type="checkbox"
            checked={excludeEval}
            onChange={(e) => setExcludeEval(e.target.checked)}
            className="h-3 w-3 accent-[#4da8ff]"
          />
          <span className="font-mono text-[11px] text-ink">Exclude eval-harness turns</span>
        </label>

        <div className="ml-auto flex items-center gap-2 pb-1">
          <button
            onClick={onClose}
            className="rounded-chip border border-line px-2 py-1 font-mono text-[11px] text-ink-lo hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-chip border border-st-info/50 bg-st-info/10 px-2 py-1 font-mono text-[11px] text-st-info disabled:opacity-50"
          >
            {saving ? "Saving…" : "Apply"}
          </button>
        </div>
      </div>

      <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
        Critical takes precedence over nominal and idle. With tool failures included, a turn
        that returned successfully but had a failed SQL or search step still marks the agent
        critical — a broader and noisier signal than request-level errors alone.
      </p>

      {err && <p className="mt-1 font-mono text-[10px] text-st-critical">{err}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label-micro">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
        inputMode="numeric"
        className="w-24 rounded-chip border border-line bg-inset px-2 py-1 font-mono text-[12px] text-ink-hi outline-none focus:border-line-strong"
      />
    </label>
  );
}
