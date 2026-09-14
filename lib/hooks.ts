"use client";

import { useQuery } from "@tanstack/react-query";
import { REFRESH_MS } from "@/lib/constants";

/**
 * The single fleet poll. One timer for the whole app: TanStack Query runs a
 * timer per observer, so declaring refetchInterval on twelve panels would mean
 * twelve timers. Every panel derives from this one query via `select`.
 */
export function useFleet(window: string) {
  return useQuery({
    queryKey: ["fleet", window],
    queryFn: async () => {
      const res = await fetch(`/api/fleet?window=${encodeURIComponent(window)}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? `HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false, // don't hammer the warehouse from idle tabs
    staleTime: REFRESH_MS, // keep mount/focus refetches off the 10-min clock
    gcTime: 30 * 60_000,
    placeholderData: (prev: unknown) => prev, // panels never blank mid-refetch
    retry: 2,
  });
}

export function useLimits(window: string) {
  return useQuery({
    queryKey: ["limits", window],
    queryFn: async () => {
      const res = await fetch(`/api/limits?window=${encodeURIComponent(window)}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? `HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS,
    placeholderData: (prev: unknown) => prev,
    retry: 2,
  });
}

/**
 * Saturation over time, for the /limits drill-down. Separate from `useLimits`
 * (which supplies the home page's ceiling gauges) so neither page fetches
 * series it never draws.
 */
export function useLimitTrends(window: string) {
  return useQuery({
    queryKey: ["limit-trends", window],
    queryFn: async () => {
      const res = await fetch(`/api/limit-trends?window=${encodeURIComponent(window)}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? `HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS,
    placeholderData: (prev: unknown) => prev,
    retry: 2,
  });
}

export function useAgent(window: string, agent: string | null, trace: string | null) {
  return useQuery({
    queryKey: ["agent", window, agent, trace],
    queryFn: async () => {
      const p = new URLSearchParams({ window });
      if (agent) p.set("agent", agent);
      if (trace) p.set("trace", trace);
      const res = await fetch(`/api/agent?${p.toString()}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? `HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS,
    placeholderData: (prev: unknown) => prev,
    retry: 2,
  });
}

export function useFeedback() {
  return useQuery({
    queryKey: ["feedback"],
    queryFn: async () => {
      const res = await fetch("/api/feedback");
      if (!res.ok) throw new Error((await res.json())?.error ?? `HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS,
    placeholderData: (prev: unknown) => prev,
    retry: 2,
  });
}
