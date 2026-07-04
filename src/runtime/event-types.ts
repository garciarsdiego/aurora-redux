/**
 * Closed registry of event types emitted via insertEvent across the codebase.
 *
 * Adding a new event type requires:
 *   1. Adding the literal here.
 *   2. Eventually defining a Zod schema for the payload (deferred to a later
 *      sprint — see TODO at the bottom of this file).
 *
 * NOTE — this registry is INFORMATIONAL today. `insertEvent` does NOT yet
 * enforce membership at the boundary, and the existing 142+ call sites have
 * NOT been migrated to import {@link OmniforgeEventType}. The migration of
 * call sites + payload schema validation is intentionally deferred to a
 * separate sprint to keep this PR tiny and reversible.
 *
 * Source: harvested from `grep -rEoz "insertEvent\([^)]*\)" src/` plus the
 * existing `WorkflowProgressEvent['type']` union in
 * src/brain/executor/types.ts.
 *
 * Last harvest: 2026-05-09 (F7-1).
 */

export const EVENT_TYPES = [
  // ───────────────── Workflow lifecycle ─────────────────
  'workflow_started',
  'workflow_completed',
  'workflow_consolidated',
  'workflow_paused',
  'workflow_pause_requested',
  'workflow_resumed',
  'workflow_resume_requested',
  'workflow_resume_prepared',
  'workflow_cancelled',
  'workflow_canceled', // legacy spelling kept on purpose — emitted by older paths
  'workflow_cancel_requested',
  'workflow_cancel_check_failed',
  'workflow_timeout',
  'workflow_background_error',
  'workflow_budget_exceeded',
  'global_budget_exceeded',
  'workflow_parallelism_limited',
  'workflow_quota_check_unavailable',
  'workflow_cli_permission_mode',

  // Workflow validation
  'workflow_validation_started',
  'workflow_validation_passed',
  'workflow_validation_failed',
  'workflow_validation_skipped',
  'workflow_validation_error',
  'workflow_validation_exhausted',
  // Aurora-parity Wave 1 — code-root resolution + test self-fix loop
  'validator_code_root_resolved',
  'workflow_test_validation_started',
  'workflow_test_validation_passed',
  'workflow_test_validation_failed',
  'workflow_test_validation_skipped',
  'workflow_test_validation_error',
  'workflow_test_validation_exhausted',

  // v2 validators (profile-based heuristic check on aggregated task outputs)
  'validator_invoked',
  'validator_passed',
  'validator_failed',
  // Emitted when workflow.metadata JSON is malformed during the validation step
  'consolidation_metadata_parse_failed',
  // Emitted by runConsolidation when doConsolidate throws (existing call site)
  'workflow_consolidation_error',
  'workflow_consolidation_timeout',
  // OPP-C1 (2026-05-23) — two-stage map-reduce consolidation for high-fan-in
  // workflows (upstream task count > 4). Emitted from runConsolidation in
  // src/brain/executor/consolidation.ts to provide trace visibility into the
  // MAP (parallel per-task summary) and REDUCE (final synthesis) phases.
  'consolidation_map_started',
  'consolidation_map_completed',
  'consolidation_reduce_started',
  'consolidation_reduce_completed',

  // Workflow quality (final-reviewer)
  'workflow_final_quality_reviewed',
  'workflow_final_quality_gate_blocked',
  'workflow_quality_fix_tasks_created',
  // W2 auto-remediation child workflow lifecycle (2026-05-11)
  'workflow_awaiting_remediation',
  'workflow_remediation_completed',
  'workflow_remediation_started',
  'workflow_remediation_failed',
  'workflow_remediation_pending_tasks_remaining',
  'workflow_remediation_resolve_error',

  // Workflow log audit
  'workflow_log_audit_requested',
  'workflow_log_audit_completed',

  // ───────────────── Batch (group of tasks) ─────────────────
  'batch_started',
  'batch_completed',

  // ───────────────── Task lifecycle ─────────────────
  'task_started',
  'task_completed',
  'task_failed',
  'task_retrying',
  'task_killed',
  'task_cancelled_by_workflow',
  'task_cleaned_up',
  'task_hung',
  'task_lease_acquired',
  'task_lease_expired',
  'task_lease_heartbeat_error',
  'task_credential_rotation_needed',
  'task_timeout_extended',
  'task_timeout_cap_reached',
  'task_needs_compaction',

  // Task review / refine
  'task_reviewed',
  'task_review_outcome',
  'task_quality_reviewed',
  'task_quality_gate_blocked',
  // W2 auto-remediation: emitted when quality gate failure auto-spawns a child workflow
  'task_remediation_scheduled',
  'task_remediation_spawn_error',
  'task_quality_gate_auto_fix_created',
  'task_quality_gate_auto_fix_error',
  'task_refining',
  'task_refine_error',
  'task_refine_exhausted',
  'task_refine_timeout',
  'task_refine_budget_exceeded',

  // Task failover / routing
  'task_failover_classified',
  'task_fallback_model_needed',
  'task_fallback_model_selected',
  'task_routing_skipped',
  'task_steer_received',

  // Task input/output context
  'task_input_sliced',
  'task_carry_injected',
  'task_auto_summary_completed',
  'task_auto_summary_injected',

  // Task injection scan
  'task_injection_detected',
  'task_injection_blocked',

  // Task tracing
  'task_trace_start_error',
  'task_trace_end_error',

  // Task worktree
  'task_worktree_skipped',
  'task_worktree_source_dirty',

  // Task CLI permission mode
  'task_cli_permission_mode_applied',

  // ───────────────── Streaming (CLI/LLM) ─────────────────
  // Chunks themselves are NOT persisted in DB — only _start/_end with aggregates
  // (D-H2.026 keeps the events table out of the hot path).
  'task_streaming_start',
  'task_streaming_chunk',
  'task_streaming_end',
  'cli_tool_call',
  'cli_killed_on_cancel',

  // ───────────────── Adaptive supervisor / subagents ─────────────────
  'supervisor_iteration',
  'adaptive_supervisor_error',
  // W1 convergence detector — supervisor exits loop early when no work for 2 consecutive iterations
  'adaptive_supervisor_converged',
  'subagent_announced',
  'subagent_announce_failed',
  'subagent_spawned',
  'subagent_spawn_failed',
  'subagent_continued',
  'subagent_completed',
  'subagent_steered',
  'subagent_messages_cancelled',
  'subagent_orphan_restarted',
  'subagent_orphan_failed',

  // ───────────────── HITL ─────────────────
  'hitl_gate_pending',
  'hitl_gate_decided',
  'hitl_gate_orphan_recovered',
  'hitl_policy_approved',
  'hitl_telegram_sent',
  'hitl_slack_sent',
  // W4 detached-daemon UX — emitted once per workflow when stdin is not a TTY
  'hitl_terminal_disabled_detached',
  'permission_decided',
  'tool_policy_approval_granted',
  'tool_blocked_by_allowlist',
  // Aurora-parity Wave 1 — precommit self-review gate (secret scan on diff)
  'task_precommit_scan',
  'task_precommit_finding',
  'task_file_scope_violation',

  // ───────────────── Architecture contracts ─────────────────
  'architecture_contract_recorded',
  'architecture_contract_error',
  'architecture_contract_load_error',

  // ───────────────── Skills / context ─────────────────
  'skills_preflight',
  'skill_execution_mode_applied',
  'context_compacted',
  'context_compaction',
  'transition_context',
  'triggers_detected',
  'state_schema_violation',

  // ───────────────── Budget / cost ─────────────────
  'budget_threshold_crossed',
  'model_call_recorded',
  'model_call_record_error',
  // W5 SSE expansion — push these to dashboard so 8s poll becomes a backstop only
  'cost_delta',
  'latest_event_metadata',
  // M1 (2026-05-12) gap-closure events — pre-populated for Wave 1 parallelism
  'task_input_json_malformed',
  'vault_write_audited',
  'vault_delete_audited',
  'config_updated',
  'workflow_remediation_picked_up',
  'webhook_rate_limited',
  'actor_token_compared',
  'daemon_recovery_sweep_completed',
  'rule_evaluated',
  'rule_blocked_action',
  'rule_warning',
  'tool_disabled_by_policy',
  'state_schema_parse_failed',
  'external_mcp_tool_invoked',
  'external_mcp_server_connected',
  'external_mcp_server_disconnected',

  // ───────────────── Artifacts ─────────────────
  'artifact_save_error',

  // ───────────────── Dashboard ops (admin) ─────────────────
  'dashboard_alert_acknowledged',
  'dashboard_task_patched',
  'dashboard_task_replay_enqueued',
  'dashboard_task_retry_started',
  'dashboard_workflow_renamed',

  // ───────────────── MCP review/handoff ─────────────────
  'mcp_architecture_review_requested',
  'mcp_product_review_requested',
  'mcp_fix_task_created',
  'mcp_task_handoff_posted',

  // ───────────────── Runtime (advisor / persistent sessions) ─────────────────
  // Dotted namespace (advisor + persistent runtime). Kept as-is even though
  // they break the underscore convention — they predate this registry.
  'runtime.session.created',
  'runtime.session.fallback',
  'advisor_step_start',
  'advisor_step_chunk',
  'advisor_step_end',

  // ───────────────── Aurora 1.0 Batch-0 (2026-05-28) ─────────────────
  'supervisor_cancelled',        // BRAIN-03: adaptive supervisor stopped by workflow cancel
  'cost_insert_failed',          // OPS-02: per-call cost insert failed (no longer swallowed)
  'daemon_table_self_check_completed', // OPS-02: startup table self-check result

  // ───────────────── Generic outcome buckets ─────────────────
  'hard_success',
] as const;

export type OmniforgeEventType = (typeof EVENT_TYPES)[number];

/**
 * Type guard. Returns true if `t` is a registered event type.
 *
 * Use at boundaries where an external string crosses into typed code (e.g.,
 * deserialised events from the DB or from a cross-process bridge). Inside
 * typed code prefer the literal union {@link OmniforgeEventType} directly.
 */
export function isKnownEventType(t: string): t is OmniforgeEventType {
  return (EVENT_TYPES as readonly string[]).includes(t);
}

// Tier D backlog (tracked in docs/notes/2026-05-12-master-goal-plan-all-tiers.md):
//   1. Per-type Zod payload schemas + insertEvent runtime enforcement.
//   2. Migrate the ~142 insertEvent call sites to import OmniforgeEventType
//      so unknown literals trigger TS errors at the call site.
