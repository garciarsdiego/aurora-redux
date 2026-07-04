/**
 * Metrics module exports.
 *
 * The only live metric is the pass@k reliability metric (consumed by the
 * eval harness + the `omniforge_get_eval_run` MCP tool). The legacy
 * base/llm-judge/decomposer/reviewer/planner metric classes were unreachable
 * from any production entry point and removed (GHOST-08 / INTEL-07).
 */

export {
  passAtK,
  unbiasedPassAtK,
  aggregatePassAtK,
  type PassAtKSample,
  type PassAtKResult,
} from './pass-at-k.js';
