// Runtime constants for REPL Level D.
// See docs/plans/REPL-LEVEL-D.md.

export const TARGET_FPS = 30 as const;
export const FRAME_BUDGET_MS = Math.floor(1000 / TARGET_FPS); // ~33ms

export const TOKEN_BUFFER_CAP = 5000 as const;
export const EVENT_RING_CAP = 500 as const;
export const HISTORY_RING_CAP = 1000 as const;
export const HISTORY_MAX_BYTES = 10 * 1024 * 1024; // 10MB rotation (Example decision 2026-04-23)

export const STREAM_IDLE_TIMEOUT_MS_DEFAULT = 60_000;
export const DAEMON_HEALTH_TIMEOUT_MS = 500;
export const DAEMON_PORT = 20129 as const;

export const COLD_START_BUDGET_BANNER_MS = 100;
export const COLD_START_BUDGET_READY_MS = 900;

export const TERMINAL_MIN_COLS = 80;
export const TERMINAL_MIN_ROWS = 24;

// Breakpoints for responsive layout (D-H2.022 / UX spec).
export const BREAKPOINT_2_PANE_COLS = 100;
export const BREAKPOINT_3_PANE_COLS = 140;
export const BREAKPOINT_4_PANE_COLS = 180;
