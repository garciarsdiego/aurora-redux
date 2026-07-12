/**
 * dashboard-task-ops.ts
 *
 * Main orchestrator for dashboard task operations layer.
 * Splits responsibilities into focused modules:
 * - dashboard-task-ops-meta.ts: schemas, types, helper functions
 * - dashboard-task-ops-tasks.ts: task-level operations (patch, AI adjustment)
 * - dashboard-task-ops-workflows.ts: workflow-level operations (retry DAG, retry in-place)
 *
 * Gate operations live in dashboard-data-audit.ts (DashboardPendingGate); no
 * dedicated gate-mutation module exists yet.
 *
 * Original: 884 LOC → Split: ~50 LOC (orchestrator only)
 */

// Re-export types from split modules for backward compatibility
export type {
  DashboardTaskRetryMode,
  DashboardTaskRetryDag,
  DashboardTaskRetryInPlace,
  DashboardTaskAdjustResult,
} from './dashboard-task-ops-meta.js';

// Re-export schemas for backward compatibility
export {
  PatchDashboardTaskSchema,
  RetryDashboardTaskSchema,
  AdjustDashboardTaskSchema,
} from './dashboard-task-ops-meta.js';

// Import and re-export functions from split modules
export {
  patchDashboardTask,
  adjustDashboardTaskWithAi,
} from './dashboard-task-ops-tasks.js';

export {
  buildDashboardTaskRetryDag,
  prepareDashboardTaskRetryInPlace,
} from './dashboard-task-ops-workflows.js';

export {
  reloadTask,
  safeJsonObject,
  compactDashboardText,
} from './dashboard-task-ops-meta.js';
