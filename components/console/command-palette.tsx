"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { useFleet } from "@/lib/hooks";
import { useShell } from "@/components/console/console-shell";
import { WINDOWS, WINDOW_KEYS } from "@/lib/fleet-sql";

/**
 * Command palette. In an ops console this is not decoration: it is the fastest
 * path to any agent, and it is one of the strongest premium signals available.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { window: win, setWindow } = useShell();
  const { data } = useFleet(win);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const agents: Array<{ agentFqn: string; displayName: string; state: string }> =
    data?.hex ?? [];

  const go = (path: string) => {
    router.push(path);
    onOpenChange(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-void/70 pt-[12vh] backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <Command
        label="Command palette"
        className="w-[min(560px,92vw)] overflow-hidden rounded-panel border border-line-strong bg-panel/95 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-3 py-2">
          <Command.Input
            autoFocus
            placeholder="Search agents, pages, windows…"
            className="w-full bg-transparent font-mono text-[13px] text-ink-hi outline-none placeholder:text-ink-faint"
          />
        </div>
        <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
          <Command.Empty className="px-2 py-6 text-center font-mono text-[12px] text-ink-faint">
            No matches
          </Command.Empty>

          <Command.Group heading="Pages" className="[&_[cmdk-group-heading]]:label-micro [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            {[
              ["Fleet overview", "/"],
              ["Limits & saturation", "/limits"],
              ["Agent deep dive", "/agents"],
              ["Feedback analysis", "/feedback"],
            ].map(([label, href]) => (
              <Command.Item
                key={href}
                value={`page ${label}`}
                onSelect={() => go(href)}
                className="flex cursor-pointer items-center gap-2 rounded-chip px-2 py-1.5 font-mono text-[12px] text-ink data-[selected=true]:bg-raised data-[selected=true]:text-ink-hi"
              >
                {label}
              </Command.Item>
            ))}
          </Command.Group>

          {agents.length > 0 && (
            <Command.Group heading="Agents" className="[&_[cmdk-group-heading]]:label-micro [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
              {agents.map((a) => (
                <Command.Item
                  key={a.agentFqn}
                  value={`agent ${a.displayName} ${a.agentFqn}`}
                  onSelect={() => go(`/agents?agent=${encodeURIComponent(a.agentFqn)}`)}
                  className="flex cursor-pointer items-center gap-2 rounded-chip px-2 py-1.5 font-mono text-[12px] text-ink data-[selected=true]:bg-raised data-[selected=true]:text-ink-hi"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background:
                        a.state === "NOMINAL"
                          ? "#2fd8a6"
                          : a.state === "IDLE"
                            ? "#93c5fd"
                            : a.state === "CRITICAL"
                              ? "#ff5a5f"
                              : "#5a6675",
                    }}
                  />
                  <span className="truncate">{a.displayName}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
                    {a.agentFqn.split(".").slice(0, 2).join(".")}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Window" className="[&_[cmdk-group-heading]]:label-micro [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            {WINDOW_KEYS.map((w) => (
              <Command.Item
                key={w}
                value={`window ${w} ${WINDOWS[w].label}`}
                onSelect={() => {
                  setWindow(w);
                  onOpenChange(false);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-chip px-2 py-1.5 font-mono text-[12px] text-ink data-[selected=true]:bg-raised data-[selected=true]:text-ink-hi"
              >
                Set window to {WINDOWS[w].label}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
