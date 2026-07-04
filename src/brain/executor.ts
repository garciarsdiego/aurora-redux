/**
 * Per-DAG cost cap guard — string literals for acceptance / dashboards:
 * - 'max_total_cost_usd' (workflow column)
 * - 'cost_cap_reached' (task skip_reason)
 * - 'workflow_cost_cap_hit' (event type)
 */

import {
  buildTransitionContext,
  formatTransitionPrefix,
  type TransitionContext,
} from '../v2/agents/transition-context.js';

export { buildTransitionContext, formatTransitionPrefix, type TransitionContext };

export {
  EXECUTOR_COST_CAP_FIELD,
  EXECUTOR_COST_CAP_SKIP_REASON,
  EXECUTOR_COST_CAP_EVENT,
} from './executor/cost-cap-meta.js';

// Step executor re-exports — the 4 new deterministic kinds added in Onda-4.
// (if_else, switch, transform, evaluator are re-exported by existing callers
// that import directly from the step-executors subdirectory.)
export { executeExtractJson } from './executor/step-executors/extract_json.js';
export { executePrint } from './executor/step-executors/print.js';
export { executeLoop } from './executor/step-executors/loop.js';
export { executeMerge } from './executor/step-executors/merge.js';

// Public API barrel — re-exports the executor surface that external modules
// (CLI, MCP tools, tests) consume. The implementation lives in `executor/`.
// `maybeCompact` is applied to inflated upstream_artifacts in executor/run-task.ts.
// Keep this list explicit so future readers see the public contract at a glance.

export { executeWorkflow, continueWorkflowExecution, runTaskLoop } from './executor/orchestrate.js';
export { resumeWorkflow, prepareWorkflowForResume } from './executor/resume.js';
export type { ResumeWorkflowOptions } from './executor/resume.js';
export { HitlModifyError } from './executor/types.js';
export type {
  WorkflowProgressEvent,
  TaskLoopOpts,
  ExecuteWorkflowOpts,
} from './executor/types.js';
export {
  WorkflowCostCapError,
  estimateUpcomingCost,
  getWorkflowMaxTotalCostUsd,
  getWorkflowUsedUsdForCap,
  enforceWorkflowCostCapBeforeTask,
} from './executor/cost-cap.js';
