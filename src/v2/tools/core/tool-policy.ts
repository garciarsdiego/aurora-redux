// Setup → Tools toggle enforcement (M1 Wave 2, gap B4).
//
// Extracted out of index.ts so sibling tool modules (calculator.ts,
// knowledge-search.ts) can call `assertToolEnabled` without a circular
// import back into index.ts — index.ts itself also imports from here.

import { initDb } from '../../../db/client.js';
import { insertEvent } from '../../../db/persist.js';
import { getDbPath } from '../../../utils/config.js';
import type { ToolContext } from '../registry.js';

/**
 * Open a DB handle, write a single audit event, and close it again — all
 * best-effort. Telemetry (DB unavailable, insertEvent throwing) must never
 * mask the original error/result the caller is already returning/throwing,
 * so any failure here is swallowed silently.
 */
export function bestEffortAuditEvent(
  workflowId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  try {
    const db = initDb(getDbPath());
    try {
      insertEvent(db, { workflow_id: workflowId, type, payload });
    } finally {
      db.close();
    }
  } catch {
    // Telemetry must not mask the original error/result.
  }
}

/**
 * Error type thrown when a tool is disabled by the workspace_tool_overrides
 * policy. Distinguished from generic errors so the executor can route this
 * as a non-retryable failure rather than treating it as a transient bug.
 */
export class ToolDisabledError extends Error {
  readonly toolId: string;
  readonly workspace: string;
  constructor(toolId: string, workspace: string) {
    super(`tool '${toolId}' is disabled for workspace '${workspace}' by Setup → Tools policy`);
    this.name = 'ToolDisabledError';
    this.toolId = toolId;
    this.workspace = workspace;
  }
}

/**
 * Consult the workspace_tool_overrides table for the given (workspace, toolId)
 * pair. Empty row → enabled (default-ON preserves behaviour for fresh installs
 * and pre-Wave-2 deployments). enabled=0 → disabled.
 *
 * The DB handle is opened fresh per call because the static tool registry
 * doesn't have access to the executor's DB. Single-operator workloads run a
 * few tool calls per workflow so the open/close cost is negligible compared
 * to the cost of the tool itself.
 */
function isToolEnabledForWorkspace(toolId: string, workspace: string): boolean {
  try {
    const db = initDb(getDbPath());
    try {
      const row = db
        .prepare(
          `SELECT enabled FROM workspace_tool_overrides
           WHERE workspace = ? AND tool_id = ?`,
        )
        .get(workspace, toolId) as { enabled: number } | undefined;
      // Absent row → default enabled.
      return row === undefined || row.enabled === 1;
    } finally {
      db.close();
    }
  } catch {
    // DB unavailable → fail OPEN so the executor doesn't grind to a halt
    // because of an unrelated DB outage. The setup-config persistence
    // failure mode is already non-blocking.
    return true;
  }
}

/**
 * Emit a `tool_disabled_by_policy` event when a tool is refused by the
 * workspace policy. Best-effort: failures to write the event must not mask
 * the original ToolDisabledError that the caller will throw.
 */
function recordToolDisabledEvent(toolId: string, ctx: ToolContext): void {
  bestEffortAuditEvent(ctx.workflowId, 'tool_disabled_by_policy', {
    tool_id: toolId,
    workspace: ctx.workspace,
  });
}

/**
 * Guard called at the start of every core-tool `execute()`. Throws
 * `ToolDisabledError` when the operator has disabled the tool for the
 * active workspace via the Setup → Tools pane.
 */
export function assertToolEnabled(toolId: string, ctx: ToolContext): void {
  if (isToolEnabledForWorkspace(toolId, ctx.workspace)) return;
  recordToolDisabledEvent(toolId, ctx);
  throw new ToolDisabledError(toolId, ctx.workspace);
}
