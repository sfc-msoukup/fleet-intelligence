"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Gauge, Radar, MessageSquareWarning, Command } from "lucide-react";
import { APP_TITLE, APP_SUBTITLE } from "@/lib/constants";
import { StatusStrip } from "@/components/console/status-strip";
import { CommandPalette } from "@/components/console/command-palette";

/** Window selection is shared shell state so every page honours one selector. */
type ShellCtx = {
  window: string;
  setWindow: (w: string) => void;
};
const Ctx = createContext<ShellCtx>({ window: "24h", setWindow: () => {} });
export const useShell = () => useContext(Ctx);

const NAV = [
  { href: "/", label: "Fleet", icon: Activity, hint: "Home: KPIs, ceilings and fleet" },
  { href: "/limits", label: "Limits", icon: Gauge, hint: "Saturation over time" },
  { href: "/agents", label: "Agents", icon: Radar, hint: "Per-agent deep dive" },
  { href: "/feedback", label: "Feedback", icon: MessageSquareWarning, hint: "Feedback analysis" },
];

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [window, setWindow] = useState("24h");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <Ctx.Provider value={{ window, setWindow }}>
      {/* One CSS grid: 52px icon rail + content, 44px strip + main.
          A rail rather than a labelled sidebar - labels would cost a fifth of
          the horizontal budget on a dense ops screen. */}
      <div className="grid h-dvh grid-cols-[52px_1fr] grid-rows-[44px_1fr] overflow-hidden">
        {/* rail */}
        <nav
          className="row-span-2 flex flex-col items-center gap-1 border-r border-line bg-base py-2"
          aria-label="Primary"
        >
          <Link
            href="/"
            className="mb-2 grid h-8 w-8 place-items-center border border-line-strong bg-inset text-[10px] font-display tracking-[0.08em] text-ink-hi"
            title={`${APP_TITLE} — ${APP_SUBTITLE}`}
          >
            FI
          </Link>
          {NAV.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.hint}
                aria-current={active ? "page" : undefined}
                className={`group relative grid h-9 w-9 place-items-center rounded-chip transition-colors duration-150 ${
                  active ? "bg-raised text-ink-hi" : "text-ink-lo hover:text-ink hover:bg-raised/60"
                }`}
              >
                {/* active indicator: a hairline, not a coloured bar */}
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-px -translate-y-1/2 bg-ink-hi" />
                )}
                <Icon size={16} strokeWidth={1.5} />
                <span className="sr-only">{item.label}</span>
              </Link>
            );
          })}
          <div className="mt-auto">
            <button
              onClick={openPalette}
              title="Command palette (Cmd/Ctrl + K)"
              className="grid h-9 w-9 place-items-center text-ink-faint transition-colors hover:text-ink"
            >
              <Command size={15} strokeWidth={1.5} />
              <span className="sr-only">Open command palette</span>
            </button>
          </div>
        </nav>

        <StatusStrip onOpenPalette={openPalette} />

        <main className="overflow-y-auto overflow-x-hidden bg-void">
          <div className="mx-auto max-w-[1600px] p-4">{children}</div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </Ctx.Provider>
  );
}
