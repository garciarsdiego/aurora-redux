-- Migration 047 (M1 Wave 2, 2026-05-12):
-- Per-workspace tool enablement overrides for the Setup → Tools pane (gap B4).
--
-- Before this migration, the Setup → Tools pane toggles were local-only —
-- flipping them in the UI did nothing on the daemon side. Tools were always
-- reachable as long as they were registered in src/v2/tools/core/index.ts.
--
-- With this table, the executor's tool-call path (`src/v2/tools/core`)
-- consults `workspace_tool_overrides` and refuses to execute a tool when
-- enabled = 0 for the active workspace + tool_id. A `tool_disabled_by_policy`
-- event is emitted under the active workflow_id so the dashboard surfaces the
-- reason; a `ToolDisabledError` is thrown so the executor escalates the
-- failure rather than silently no-op'ing.
--
-- Empty table → all tools enabled (preserves prior behaviour for fresh
-- installs). The toggle endpoint `POST /api/dashboard/setup/tools/:toolId/toggle`
-- writes rows here.
--
-- Composite primary key (workspace, tool_id) so a single row per pair; the
-- secondary index on workspace alone keeps the per-workspace lookup hot
-- (one SELECT per tool call is acceptable for single-operator workloads).

CREATE TABLE IF NOT EXISTS workspace_tool_overrides (
  workspace  TEXT    NOT NULL,
  tool_id    TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace, tool_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_tool_overrides_workspace
  ON workspace_tool_overrides(workspace);
