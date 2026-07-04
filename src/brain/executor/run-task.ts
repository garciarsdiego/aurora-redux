// Facade re-export — the implementation now lives in `./run-task/`.
//
// Split rationale (Agent M2-A2, refactor/split-god-files): the original
// file grew from 648 → 1894 LOC across W1-W5 fixes and was the second
// hottest file in the executor module. We extracted phase-scoped helpers
// (cancel signals, versioned-definition consumption, reviewer workspace
// resolution, secret resolution, context-packet builder, worktree prep,
// trace spans, tool-policy approval, state-schema check, quality gate)
// into sibling modules and kept `executeTaskWithRetry` itself in
// `./run-task/index.ts`. Every previously-exported name is re-exported
// here so callers importing from `../executor/run-task` (orchestrate.ts,
// auto-summary.ts, the tests) continue to compile without churn.
export {
  executeTaskWithRetry,
  checkAborted,
  consumeVersionedDefinition,
  resolveReviewerWorkspaceDir,
} from './run-task/index.js';
