/** App title - shown in the rail, status strip and browser tab */
export const APP_TITLE = "Fleet Intelligence";
export const APP_SUBTITLE = "Cortex Agent Mission Control";

/** Path to the logo in /public */
export const LOGO_SRC = "/icon.svg";

/** Refresh cadence, aligned to the serverless task that rebuilds the tables. */
export const REFRESH_MS = 600_000; // 10 minutes

/** Status colour tokens, mirrored from globals.css for chart series. */
export const STATUS = {
  NOMINAL: { color: "#2fd8a6", glyph: "\u25CF", label: "NOMINAL" },
  IDLE: { color: "#93c5fd", glyph: "\u25D0", label: "IDLE" },
  CRITICAL: { color: "#ff5a5f", glyph: "\u25A0", label: "CRITICAL" },
  OFF: { color: "#5a6675", glyph: "\u25CB", label: "OFF" },
  INFO: { color: "#4da8ff", glyph: "\u25C6", label: "INFO" },
} as const;

export type StatusKey = keyof typeof STATUS;

/** Data-series ramp. Deliberately not the status colours. */
export const SERIES = ["#7ad7f0", "#4fb8c9", "#c8b88a", "#d98c6a", "#8e9bb0", "#5f7d95"];

/**
 * Token category colours, stable across every chart that breaks tokens out.
 * "Fresh Input" is the portion of input that was neither a cache read nor a
 * cache write; the three together reconstruct input exactly.
 */
export const TOKEN_COLORS: Record<string, string> = {
  "Cache Read": "#4fb8c9",
  "Cache Write": "#5f7d95",
  "Fresh Input": "#7ad7f0",
  Input: "#7ad7f0",
  Output: "#c8b88a",
  Plan: "#d98c6a",
};
