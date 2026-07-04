/**
 * Aurora Action Gate — classification taxonomy and DB-backed disposition lookup.
 *
 * Adapted from Runfusion/Fusion (MIT) — packages/engine/src/agent-action-gate.ts
 * @ 5f6d998cb2e94ac90f6c204911c82c08e2640e05
 *
 * Aurora-specific: no @fusion/core imports. The gate evaluates tool calls
 * against per-agent (or '__default__') policy rows stored in
 * agent_action_policies (migration 041). If the DB is unavailable for any
 * reason, the gate falls back to 'allow' so it never blocks execution
 * when policy storage is temporarily inaccessible.
 */

import type { Database } from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

export type ActionCategory =
  | 'git_write'
  | 'file_write_delete'
  | 'command_execution'
  | 'network_api'
  | 'task_agent_mutation';

export type ActionDisposition = 'allow' | 'block' | 'require-approval';

export interface ActionGateDecision {
  disposition: ActionDisposition;
  category: ActionCategory | 'exempt';
  toolName: string;
  summary: string;
}

// ── Classification sets ───────────────────────────────────────────────────────

/**
 * Read-only coordination tools that never perform external mutations.
 * These always return disposition='allow' and bypass DB policy lookup.
 */
const EXEMPT_TOOLS = new Set<string>([
  'omniforge_get_workflow_status',
  'omniforge_list_workflows',
  'omniforge_list_models',
  'omniforge_get_model_calls',
  'omniforge_list_versioned_definitions',
  'omniforge_list_eval_cases',
  'omniforge_get_eval_run',
  'omniforge_list_patterns',
  // read-only introspection tools
  'omniforge_get_context_bundle',
  'omniforge_get_architecture_contract',
  'omniforge_read_task_thread',
  'omniforge_inspect_workflow_diff',
  'omniforge_opencode_sync_models',
  'omniforge_tail_cli',
]);

/**
 * Tools classified as command_execution: shell or filesystem read operations
 * that have side effects or read system state outside the workspace sandbox.
 */
const COMMAND_EXECUTION_TOOLS = new Set<string>([
  'bash',
  'omniforge_read_file',
  // read tools from v2/tools/core — read-only but execute in system context
  'file-read',
  'knowledge-search',
  'current-time',
  'calculator',
  // search/glob are read-only filesystem operations
  'glob',
  'grep',
]);

/**
 * Tools classified as file_write_delete: write or mutate workspace files.
 */
const FILE_WRITE_DELETE_TOOLS = new Set<string>([
  'file-write',
  'apply-patch',
]);

/**
 * Tools classified as network_api: make outbound HTTP/network calls.
 */
const NETWORK_API_TOOLS = new Set<string>([
  'http-request',
  'web-fetch',
  'web-search',
]);

/**
 * Tools classified as task_agent_mutation: create, modify, or dispatch
 * workflows, agents, patterns, policies, or eval records.
 */
const TASK_AGENT_MUTATION_TOOLS = new Set<string>([
  'omniforge_run_workflow',
  'omniforge_plan_workflow',
  'omniforge_approve_gate',
  'omniforge_save_pattern',
  'omniforge_import_pattern',
  'omniforge_export_pattern',
  'omniforge_set_hermes_model',
  'omniforge_set_config',
  'omniforge_pin_versioned_definition',
  'omniforge_register_versioned_definition',
  'omniforge_register_eval_case',
  'omniforge_route_model',
  'omniforge_post_task_handoff',
  'omniforge_create_fix_task',
  'omniforge_request_architecture_review',
  'omniforge_request_product_review',
  'omniforge_replay_persona_version',
  'omniforge_run_meta_workflow',
  'omniforge_task_await',
  'omniforge_task_cancel',
  'omniforge_vault_write',
  'omniforge_vault_delete',
  'omniforge_vault_merge',
  'omniforge_builder_chat',
  'cli_spawn',
]);

// ── Classification logic ─────────────────────────────────────────────────────

function classifyTool(toolName: string): ActionCategory | 'exempt' {
  if (EXEMPT_TOOLS.has(toolName)) return 'exempt';
  if (COMMAND_EXECUTION_TOOLS.has(toolName)) return 'command_execution';
  if (FILE_WRITE_DELETE_TOOLS.has(toolName)) return 'file_write_delete';
  if (NETWORK_API_TOOLS.has(toolName)) return 'network_api';
  if (TASK_AGENT_MUTATION_TOOLS.has(toolName)) return 'task_agent_mutation';

  // Future-proofing: any name containing 'git_write' is classified accordingly.
  if (toolName.includes('git_write')) return 'git_write';

  // Advisor tools (registered dynamically) — treat as task_agent_mutation.
  // They invoke LLM chains and may write context records.
  if (toolName.startsWith('omniforge_advisor_') || toolName.startsWith('advisor_')) {
    return 'task_agent_mutation';
  }

  // Unknown tools: default to task_agent_mutation (most restrictive non-exempt
  // category) so unrecognised tools require an explicit policy allow.
  return 'task_agent_mutation';
}

// ── DB policy lookup ─────────────────────────────────────────────────────────

interface PolicyRow {
  disposition: ActionDisposition;
}

function queryDisposition(
  db: Database,
  agentId: string,
  category: ActionCategory,
): ActionDisposition {
  try {
    // Agent-specific policy first.
    const specific = db
      .prepare<[string, string], PolicyRow>(
        'SELECT disposition FROM agent_action_policies WHERE agent_id = ? AND category = ?',
      )
      .get(agentId, category);
    if (specific) return specific.disposition;

    // Fall back to __default__ baseline.
    if (agentId !== '__default__') {
      const defaultRow = db
        .prepare<[string, string], PolicyRow>(
          'SELECT disposition FROM agent_action_policies WHERE agent_id = ? AND category = ?',
        )
        .get('__default__', category);
      if (defaultRow) return defaultRow.disposition;
    }

    // If neither row exists (table not yet seeded), treat as allow.
    return 'allow';
  } catch {
    // DB unavailable — safe fallback so gate never blocks execution.
    return 'allow';
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate whether a tool call should be allowed, blocked, or require
 * approval according to the per-agent action policy stored in the DB.
 *
 * Safe fallback: if the DB is unavailable or the migration has not been
 * applied yet, the function returns disposition='allow' rather than
 * throwing, so the gate is never a reliability blocker.
 */
export function evaluateActionGate(
  toolName: string,
  agentId: string,
  db: Database,
): ActionGateDecision {
  const category = classifyTool(toolName);

  if (category === 'exempt') {
    return {
      disposition: 'allow',
      category: 'exempt',
      toolName,
      summary: `${toolName}: exempt read-only coordination tool`,
    };
  }

  const disposition = queryDisposition(db, agentId, category);

  return {
    disposition,
    category,
    toolName,
    summary: `${toolName}: ${category} → ${disposition}`,
  };
}
