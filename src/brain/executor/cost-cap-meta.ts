/** Stable identifiers for per-DAG cost cap — imported by `executor.ts` barrel + cost-cap guard. */
export const EXECUTOR_COST_CAP_FIELD = 'max_total_cost_usd' as const;
export const EXECUTOR_COST_CAP_SKIP_REASON = 'cost_cap_reached' as const;
export const EXECUTOR_COST_CAP_EVENT = 'workflow_cost_cap_hit' as const;
