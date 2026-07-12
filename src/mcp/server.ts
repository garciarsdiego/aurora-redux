import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { runWorkflowTool } from './tools/run_workflow.js';
import { planWorkflowTool } from './tools/plan_workflow.js';
import { getWorkflowStatusTool } from './tools/get_workflow_status.js';
import { listWorkflowsTool } from './tools/list_workflows.js';
import { approveGateTool } from './tools/approve_gate.js';
import { listPatternsTool } from './tools/list_patterns.js';
import { savePatternTool } from './tools/save_pattern.js';
import { exportPatternTool } from './tools/export_pattern.js';
import { importPatternTool } from './tools/import_pattern.js';
import { listModelsTool } from './tools/list_models.js';
import { setHermesModelTool } from './tools/set_hermes_model.js';
import { setConfigTool } from './tools/set_config.js';
import { readFileTool } from './tools/read_file.js';
import { registerVersionedDefinitionTool } from './tools/register_versioned_definition.js';
import { listVersionedDefinitionsTool } from './tools/list_versioned_definitions.js';
import { pinVersionedDefinitionTool } from './tools/pin_versioned_definition.js';
import { routeModelTool } from './tools/route_model.js';
import { opencodeSyncModelsTool } from './tools/opencode_sync_models.js';
import { getModelCallsTool } from './tools/get_model_calls.js';
import { getContextBundleTool } from './tools/get_context_bundle.js';
import { getArchitectureContractTool } from './tools/get_architecture_contract.js';
import { postTaskHandoffTool } from './tools/post_task_handoff.js';
import { readTaskThreadTool } from './tools/read_task_thread.js';
import { inspectWorkflowDiffTool } from './tools/inspect_workflow_diff.js';
import { createFixTaskTool } from './tools/create_fix_task.js';
import { requestArchitectureReviewTool } from './tools/request_architecture_review.js';
import { requestProductReviewTool } from './tools/request_product_review.js';
import { registerEvalCaseTool } from './tools/register_eval_case.js';
import { listEvalCasesTool } from './tools/list_eval_cases.js';
import { getEvalRunTool } from './tools/get_eval_run.js';
import { replayPersonaVersionTool } from './tools/replay_persona_version.js';
import { runMetaWorkflowTool } from './tools/run_meta_workflow.js';
import { TailCliSchema, tailCliTool } from './tools/tail_cli.js';
import {
  TaskAwaitSchema,
  TaskCancelSchema,
  omniforgeTaskAwait,
  omniforgeTaskCancel,
} from './tools/task_async.js';
import {
  omniforge_vault_delete,
  omniforge_vault_list,
  omniforge_vault_merge,
  omniforge_vault_read,
  omniforge_vault_write,
} from './tools/vault.js';
import {
  buildAdvisorToolDefinitions,
  isAdvisorToolName,
  runAdvisorTool,
} from './tools/advisor_tools.js';
import { omniforge_builder_chat } from './tools/builder_chat.js';
import {
  omniforge_credential_create,
  omniforge_credential_get,
  omniforge_credential_get_by_service,
  omniforge_credential_list,
  omniforge_credential_update,
  omniforge_credential_delete,
  omniforge_credential_rotate,
  omniforge_credential_sync,
  omniforge_credential_sync_status,
  omniforge_credential_audit_log,
  omniforge_credential_validate_routing,
  handleCredentialCreate,
  handleCredentialGet,
  handleCredentialGetByService,
  handleCredentialList,
  handleCredentialUpdate,
  handleCredentialDelete,
  handleCredentialRotate,
  handleCredentialSync,
  handleCredentialSyncStatus,
  handleCredentialAuditLog,
  handleCredentialValidateRouting,
} from './tools/credential_manager.js';

export const TOOLS = [
  {
    name: 'omniforge_plan_workflow',
    description:
      'Decomposes an objective into a multi-agent DAG and returns the plan for review — without executing. Use this BEFORE omniforge_run_workflow when you want to show the plan to the user for approval. Returns plan (task list) and dag_json to pass to run_workflow.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace name (initech, globex, acme, internal)',
        },
        objective: {
          type: 'string',
          description: 'Natural-language description of what to accomplish',
        },
        workflow_mode: {
          type: 'string',
          enum: ['standard', 'existing_code_feature'],
          description: 'Use existing_code_feature when planning changes against an existing repository/product so architecture scout and integration contract tasks are visible before run approval.',
        },
        task_model: {
          type: 'string',
          description: 'Optional model id to bias generated tasks toward.',
        },
        max_total_cost_usd: {
          type: ['number', 'null'],
          description: 'Optional cost cap preview value to carry into the plan response.',
        },
      },
      required: ['workspace', 'objective'],
    },
  },
  {
    name: 'omniforge_run_workflow',
    description:
      'Execute an Omniforge workflow. Pass precomputed_dag (from omniforge_plan_workflow) to skip re-decomposition. Returns workflow_id, status, and task count.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace name (initech, globex, acme, internal)',
        },
        objective: {
          type: 'string',
          description: 'Natural-language description of what to accomplish',
        },
        auto_approve: {
          type: 'boolean',
          description: 'Bypass all HITL gates automatically (default: false)',
        },
        precomputed_dag: {
          type: 'string',
          description: 'dag_json returned by omniforge_plan_workflow — skips re-decomposition',
        },
        workflow_mode: {
          type: 'string',
          enum: ['standard', 'existing_code_feature'],
          description: 'Use existing_code_feature when modifying an existing repository/product so Omniforge injects architecture scout and integration contract tasks.',
        },
        cli_permission_mode: {
          type: 'string',
          enum: ['safe', 'autonomous'],
          description: 'CLI execution profile. autonomous requires explicit operator intent and is audited.',
        },
      },
      required: ['workspace', 'objective'],
    },
  },
  {
    name: 'omniforge_get_workflow_status',
    description:
      'Returns the current status, tasks, and recent events for an Omniforge workflow.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'Workflow ID returned by omniforge_run_workflow',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_get_model_calls',
    description:
      'Returns the local model-call ledger for a workflow, including per-call model, token usage, latency and cost totals when providers report usage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'Workflow ID whose model calls should be inspected',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_get_context_bundle',
    description:
      'Returns the sanitized context orchestration bundle for a workflow: channels, threads, messages, context packets, task handoffs, work items, decisions, and structured errors.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'Workflow ID whose context orchestration bundle should be inspected',
        },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_get_architecture_contract',
    description:
      'Returns the recorded ArchitectureContract for an existing-code workflow when one exists.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID to inspect' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_read_task_thread',
    description:
      'Returns the persisted context thread and messages for one workflow task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID' },
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['workflow_id', 'task_id'],
    },
  },
  {
    name: 'omniforge_post_task_handoff',
    description:
      'Posts a redacted structured handoff message for a workflow task and records an audit event.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string' },
        task_id: { type: 'string' },
        attempt: { type: 'number' },
        kind: { type: 'string', enum: ['summary', 'artifact', 'diff', 'decision', 'error', 'instruction', 'mixed'] },
        title: { type: 'string' },
        body: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
        files_touched: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        safe_context: { type: 'object' },
      },
      required: ['workflow_id', 'task_id', 'body'],
    },
  },
  {
    name: 'omniforge_inspect_workflow_diff',
    description:
      'Reports git status for workflow task execution roots without modifying files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_create_fix_task',
    description:
      'Creates an auditable workflow fix task. Defaults to dry-run; approved-run requires approved_by.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string' },
        title: { type: 'string' },
        objective: { type: 'string' },
        kind: { type: 'string', enum: ['llm_call', 'cli_spawn', 'tool_call'] },
        depends_on: { type: 'array', items: { type: 'string' } },
        acceptance_criteria: { type: 'string' },
        model: { type: ['string', 'null'] },
        executor_hint: { type: ['string', 'null'] },
        run_mode: { type: 'string', enum: ['dry-run', 'approved-run'] },
        approved_by: { type: 'string' },
        source_review_id: { type: 'string' },
      },
      required: ['workflow_id', 'title', 'objective', 'acceptance_criteria'],
    },
  },
  {
    name: 'omniforge_request_architecture_review',
    description:
      'Runs the architecture integration review for a workflow and records a redacted quality review, context message, and audit event.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string' },
        run_mode: { type: 'string', enum: ['dry-run', 'approved-run'] },
        approved_by: { type: 'string' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_request_product_review',
    description:
      'Runs the final product evidence review for a workflow and records issues/fix-task drafts without mutating workflow tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string' },
        run_mode: { type: 'string', enum: ['dry-run', 'approved-run'] },
        approved_by: { type: 'string' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'omniforge_register_eval_case',
    description:
      'Registers a golden eval case for a workspace. Use this to build regression suites for prompts, decomposition, routing, tools, and end-to-end workflows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for the eval case' },
        name: { type: 'string', description: 'Stable eval case name' },
        input: { type: 'object', description: 'Input payload for the eval runner' },
        expected: { type: 'object', description: 'Expected output, metric target, or rubric payload' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags such as golden, security, cost, or routing' },
      },
      required: ['workspace', 'name', 'input', 'expected'],
    },
  },
  {
    name: 'omniforge_list_eval_cases',
    description:
      'Lists registered eval cases for a workspace, optionally filtered by tags. Use before running local suites or inspecting regression coverage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for eval cases' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags that must all be present' },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'omniforge_get_eval_run',
    description:
      'Returns an eval run and its per-case results. Eval execution itself stays in the SDK/harness so runners and judges remain explicit code, not arbitrary MCP payloads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        run_id: { type: 'string', description: 'Eval run ID returned by the local eval harness' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'omniforge_list_workflows',
    description:
      'Lists Omniforge workflows with optional filters. Returns workflow_id, status, objective, and task count.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: {
          type: 'string',
          description: 'Filter by workspace name',
        },
        status: {
          type: 'string',
          description: 'Filter by status (pending, executing, completed, failed)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-100, default 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'omniforge_approve_gate',
    description:
      'Approves or rejects a pending HITL gate in an Omniforge workflow. Unblocks the workflow execution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        gate_id: {
          type: 'string',
          description: 'Gate ID (hg_* format) from the workflow events or HITL notification',
        },
        decision: {
          type: 'string',
          enum: ['approve', 'reject', 'modify'],
          description: 'Whether to approve, reject, or request a plan modification for the gate',
        },
        feedback: {
          type: 'string',
          description: 'Optional reasoning or instructions (stored in gate context)',
        },
      },
      required: ['gate_id', 'decision'],
    },
  },
  {
    name: 'omniforge_list_patterns',
    description:
      'Lists captured workflow patterns for a workspace. Shows reuse stats to help decide whether to leverage an existing pattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace name (initech, globex, acme, internal)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-50, default 20)',
        },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'omniforge_save_pattern',
    description:
      'Saves a completed workflow as a reusable pattern. The workflow must be in completed status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: {
          type: 'string',
          description: 'ID of the completed workflow to save (wf_* format)',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the pattern (e.g. "competitive-analysis-v1")',
        },
      },
      required: ['workflow_id', 'name'],
    },
  },
  {
    name: 'omniforge_export_pattern',
    description:
      'Exports a pattern as a portable DAG JSON. The result can be imported into another workspace with omniforge_import_pattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern_id: {
          type: 'string',
          description: 'Pattern ID (pt_* format) from omniforge_list_patterns',
        },
      },
      required: ['pattern_id'],
    },
  },
  {
    name: 'omniforge_import_pattern',
    description:
      'Imports a DAG JSON as a named pattern into a workspace. Use with output from omniforge_export_pattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: {
          type: 'string',
          description: 'Target workspace name',
        },
        name: {
          type: 'string',
          description: 'Name for the imported pattern',
        },
        dag: {
          type: 'object',
          description: 'DAG object with a tasks array (from omniforge_export_pattern)',
        },
        objective_sample: {
          type: 'string',
          description: 'Example objective this pattern handles (optional)',
        },
      },
      required: ['workspace', 'name', 'dag'],
    },
  },
  {
    name: 'omniforge_list_models',
    description:
      'Lists available AI models from the catalog. Filter by tier (S+, S, A+, A, B+, C), use_case keyword, or provider prefix (cc, cx, gh, gemini-cli, nvidia, ollamacloud, etc).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tier: { type: 'string', description: 'Minimum tier filter (e.g. "S", "A+", "A")' },
        use_case: { type: 'string', description: 'Use case keyword (e.g. "código", "análise", "reasoning")' },
        provider: { type: 'string', description: 'Provider prefix (e.g. "cc", "cx", "gh", "gemini-cli")' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'omniforge_route_model',
    description:
      'Selects a model from the local provider matrix using use case, strategy (quality/cost/balanced), provider and required capabilities such as tool_calling, structured_output, multimodal or local.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        use_case: { type: 'string', description: 'Use case text, e.g. "Código Complexo" or "Tarefa Rápida"' },
        provider: { type: 'string', description: 'Optional provider prefix, e.g. cc, gemini-cli, ollamacloud' },
        strategy: { type: 'string', enum: ['quality', 'cost', 'balanced'], description: 'Routing objective' },
        required_capabilities: {
          type: 'array',
          items: { type: 'string', enum: ['streaming', 'structured_output', 'tool_calling', 'multimodal', 'embeddings', 'batch', 'local'] },
        },
        limit: { type: 'number', description: 'Number of ranked candidates to return (1-25, default 5)' },
      },
      required: [],
    },
  },
  {
    name: 'omniforge_opencode_sync_models',
    description:
      'Forces a fresh `opencode models` discovery and refreshes the OpenCode-routable models cached for Aurora\'s catalog. Returns count + sample of the first 25 entries. Best-effort: if opencode is not installed it returns count:0 with an error_hint instead of throwing, so workflows that do not need opencode keep working.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        bin_path: { type: 'string', description: 'Override path/basename for the opencode binary (defaults to OMNIFORGE_OPENCODE_BIN env or "opencode")' },
        timeout_ms: { type: 'number', description: 'Hard timeout for the spawn in milliseconds (1-60000, default 15000)' },
      },
      required: [],
    },
  },
  {
    name: 'omniforge_set_hermes_model',
    description:
      'Changes the base AI model that powers Hermes. Use omniforge_list_models first to confirm the model_id. The change takes effect on the next Hermes session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model_id: { type: 'string', description: 'Full model ID from the catalog (e.g. "cx/gpt-5.4", "cc/claude-opus-4-7")' },
      },
      required: ['model_id'],
    },
  },
  {
    name: 'omniforge_set_config',
    description:
      'Changes Omniforge runtime configuration. Takes effect immediately for lazy-read settings and persists to .env. Supports orchestration models and operational limits.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          enum: [
            'DECOMPOSER_MODEL',
            'TASK_MODEL',
            'REVIEWER_MODEL',
            'CONSOLIDATOR_MODEL',
            'OMNIROUTE_TIMEOUT_MS',
            'OMNIROUTE_MAX_RETRIES',
            'OMNIFORGE_MAX_PARALLEL_TASKS',
            'OMNIFORGE_ADAPTIVE_MAX_ITERATIONS',
            'OMNIFORGE_MAX_PLAN_MODIFICATIONS',
            'OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR',
            'MAX_REVIEW_TIME_MS',
            'MAX_CONSOLIDATE_TIME_MS',
            'MAX_REFINE_TIME_MS',
            'MAX_REFINE_COST_USD',
            'REFINE_COST_PER_CALL_USD',
            'REVIEW_PASS_THRESHOLD',
            'OMNIFORGE_QUOTA_GUARD',
          ],
          description: 'Config key to update',
        },
        value: { type: 'string', description: 'New safe config value (model ID, number, or supported mode)' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'omniforge_read_file',
    description:
      'Reads a file from disk and returns its content. Use after a workflow generates a file to inspect or present it. Supports ~ paths. Truncates at max_bytes (default 200 KB).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or ~ path to the file (e.g. "~/Desktop/app.html")',
        },
        max_bytes: {
          type: 'number',
          description: 'Maximum bytes to return (default 200000)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'omniforge_vault_write',
    description:
      'Writes UTF-8 content into the workspace vault for cross-task storage. Paths are relative to the workspace vault root.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for the vault entry' },
        path: { type: 'string', description: 'Relative vault path, e.g. notes/brief.md' },
        content: { type: 'string', description: 'UTF-8 content to store' },
      },
      required: ['workspace', 'path', 'content'],
    },
  },
  {
    name: 'omniforge_vault_read',
    description: 'Reads a UTF-8 entry from the workspace vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for the vault entry' },
        path: { type: 'string', description: 'Relative vault path to read' },
      },
      required: ['workspace', 'path'],
    },
  },
  {
    name: 'omniforge_vault_list',
    description:
      'Lists entries in the workspace vault, optionally filtered by a simple glob pattern.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope to list' },
        glob: { type: 'string', description: 'Optional glob, e.g. notes/*.md or **/*.json' },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'omniforge_vault_delete',
    description: 'Deletes an entry from the workspace vault.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for the vault entry' },
        path: { type: 'string', description: 'Relative vault path to delete' },
      },
      required: ['workspace', 'path'],
    },
  },
  {
    name: 'omniforge_vault_merge',
    description:
      'Deep-merges a JSON object into a JSON entry in the workspace vault, creating the entry if needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for the vault entry' },
        path: { type: 'string', description: 'Relative JSON vault path to merge into' },
        partial: { type: 'object', description: 'JSON object to deep-merge into the entry' },
      },
      required: ['workspace', 'path', 'partial'],
    },
  },
  {
    name: 'omniforge_builder_chat',
    description:
      'Conversational AI Builder — sends a message in a builder chat session. Guides the user through designing a workflow DAG via multi-turn conversation. Persists conversation in planner-sessions DB. When the user confirms a plan, materializes the orchestration via registerVersionedDefinition.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope for the builder session' },
        session_id: { type: 'string', description: 'Unique session ID (use same ID for all turns in a conversation)' },
        message: { type: 'string', description: 'User message to send to the AI Builder' },
      },
      required: ['workspace', 'session_id', 'message'],
    },
  },
  {
    name: 'omniforge_register_versioned_definition',
    description:
      'Registers an immutable versioned definition for an agent, tool, or policy. Use this to version agent roles, tool contracts, and governance policies before pinning them active.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope (default: global)' },
        kind: { type: 'string', enum: ['agent', 'tool', 'policy'], description: 'Definition kind' },
        name: { type: 'string', description: 'Stable definition name, e.g. researcher or safe-tools' },
        version: { type: 'string', description: 'Semver-like version, e.g. 1.0.0' },
        status: { type: 'string', enum: ['draft', 'active', 'deprecated', 'archived'] },
        spec: { type: 'object', description: 'JSON spec for this version' },
        created_by: { type: 'string', description: 'Actor creating the version' },
        supersedes_id: { type: 'string', description: 'Prior definition ID superseded by this version' },
        notes: { type: 'string', description: 'Operator notes for audit/replay' },
      },
      required: ['kind', 'name', 'version', 'spec'],
    },
  },
  {
    name: 'omniforge_list_versioned_definitions',
    description:
      'Lists versioned agent/tool/policy definitions with optional filters. Use to inspect available versions and audit what can be pinned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Optional workspace filter' },
        kind: { type: 'string', enum: ['agent', 'tool', 'policy'], description: 'Optional kind filter' },
        name: { type: 'string', description: 'Optional definition name filter' },
        status: { type: 'string', enum: ['draft', 'active', 'deprecated', 'archived'] },
        limit: { type: 'number', description: 'Maximum number of rows (1-500, default 100)' },
      },
      required: [],
    },
  },
  {
    name: 'omniforge_replay_persona_version',
    description:
      'Replays a registered persona snapshot version against input, runs the current live persona on the same input, and returns both outputs plus a structural diff.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        persona_id: { type: 'string', description: 'Live persona ID, e.g. decomposer or reviewer' },
        version: { type: 'string', description: 'Registered persona version to replay' },
        input: { description: 'Input payload to pass to the persona runner' },
        workspace: { type: 'string', description: 'Workspace scope for the snapshot (default: global)' },
      },
      required: ['persona_id', 'version', 'input'],
    },
  },
  {
    name: 'omniforge_run_meta_workflow',
    description:
      'Runs multiple child workflows through the meta-orchestrator with bounded concurrency and returns the aggregate MetaWorkflowResult.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        specs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique ID within this meta-workflow batch' },
              workspace: { type: 'string', description: 'Workspace for the child workflow' },
              objective: { type: 'string', description: 'Objective for the child workflow' },
              dag: { type: 'object', description: 'Optional precomputed DAG to execute' },
              patternId: { type: 'string', description: 'Optional pattern ID for traceability' },
            },
            required: ['id', 'workspace', 'objective'],
          },
          description: 'Child workflow specs to dispatch',
        },
        maxConcurrency: { type: 'number', description: 'Maximum concurrent child workflows (default: 3)' },
      },
      required: ['specs'],
    },
  },
  {
    name: 'omniforge_tail_cli',
    description:
      'Returns parsed TailEvents from the active CLI session file for a running task. Use since_event_id to page through new events. Returns events, session_path, cli_id, and total_events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Workflow ID containing the task' },
        task_id: { type: 'string', description: 'Task ID whose CLI session to tail' },
        since_event_id: { type: 'number', description: 'Return events starting from this 0-based index (optional, default 0)' },
        limit: { type: 'number', description: 'Max events to return (default 50)' },
      },
      required: ['workflow_id', 'task_id'],
    },
  },
  {
    name: 'omniforge_task_await',
    description:
      'Waits for a background Omniforge workflow/task id to complete. Polls status every 2 seconds until completed, failed, cancelled, or timeout.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Workflow/task ID returned by async execution, usually wf_*' },
        timeout_ms: { type: 'number', description: 'Maximum wait time in milliseconds (1000-1800000, default 600000)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'omniforge_task_cancel',
    description:
      'Cancels a background Omniforge workflow/task id through the daemon cancel endpoint.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Workflow/task ID to cancel, usually wf_*' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'omniforge_pin_versioned_definition',
    description:
      'Pins an agent/tool/policy version as active for a workspace. Re-running with another version_id performs rollback/roll-forward.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace: { type: 'string', description: 'Workspace scope (default: global)' },
        kind: { type: 'string', enum: ['agent', 'tool', 'policy'], description: 'Definition kind' },
        name: { type: 'string', description: 'Definition name to pin' },
        version_id: { type: 'string', description: 'Versioned definition ID returned by register/list' },
        pinned_by: { type: 'string', description: 'Actor pinning this version' },
      },
      required: ['kind', 'name', 'version_id'],
    },
  },
  // Credential management tools (Sprint 6)
  omniforge_credential_create,
  omniforge_credential_get,
  omniforge_credential_get_by_service,
  omniforge_credential_list,
  omniforge_credential_update,
  omniforge_credential_delete,
  omniforge_credential_rotate,
  omniforge_credential_sync,
  omniforge_credential_sync_status,
  omniforge_credential_audit_log,
  omniforge_credential_validate_routing,
  // Orchestration tools
  {
    name: 'omniforge_cost_analytics',
    description: 'Get cost analytics and spending patterns for workflows',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflow_id: { type: 'string', description: 'Optional workflow ID to filter costs' },
        model: { type: 'string', description: 'Optional model to filter costs' },
        limit: { type: 'number', description: 'Limit number of records (default 100)' },
      },
    },
  },
  {
    name: 'omniforge_cost_optimization',
    description: 'Get cost optimization recommendations grounded in real recorded spend',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget_usd: { type: 'number', description: 'Budget constraint for optimization' },
        remaining_tasks: { type: 'number', description: 'Estimated remaining tasks' },
        current_model: { type: 'string', description: 'Current model being used' },
        workflow_id: { type: 'string', description: 'Optional workflow ID — uses its real recorded spend as current_cost' },
      },
      required: ['current_model'],
    },
  },
  {
    name: 'omniforge_benchmark_list',
    description: 'List all benchmarks with performance metrics',
    inputSchema: {
      type: 'object' as const,
      properties: {
        use_case: { type: 'string', description: 'Filter by use case (code, debug, planning, etc.)' },
        provider: { type: 'string', description: 'Filter by provider' },
      },
    },
  },
  {
    name: 'omniforge_benchmark_run',
    description: 'Run benchmarks (real cost/latency from live provider calls; quality_score is a heuristic placeholder)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        suite_name: { type: 'string', description: 'Benchmark suite name' },
        models: { type: 'array', items: { type: 'string' }, description: 'Models to benchmark' },
        provider: { type: 'string', description: 'Provider to use (default: omniroute)' },
        use_case: { type: 'string', description: 'Use case label (default: code)' },
        test_prompts: { type: 'array', items: { type: 'string' }, description: 'Optional real prompts to benchmark against (default: one sample prompt)' },
        auto_approve: { type: 'boolean', description: 'Auto-approve benchmarks (default: false)' },
      },
      required: ['suite_name', 'models'],
    },
  },
  // 15 native advisors exposed as MCP tools (PAL replacement — AETHER ε.2).
  // Each handler does its own Zod validation against src/v2/advisors/<name>/schema.ts.
  ...buildAdvisorToolDefinitions(),
];

// ---------------------------------------------------------------------------
// Tool dispatch — each handler resolves to the text payload of a single MCP
// text content block; createOmniforgeServer wraps every call in one shared
// try/catch that normalizes failures to `{ error }` + isError.
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown> | undefined;
type ToolHandler = (args: ToolArgs) => string | Promise<string>;

/** Adapts a handler that resolves to an object so its payload is JSON text. */
const asJson =
  (fn: (args: ToolArgs) => Promise<unknown>): ToolHandler =>
  async (args) =>
    JSON.stringify(await fn(args));

async function costAnalyticsTool(args: ToolArgs): Promise<string> {
  if (!args) {
    throw new Error('Arguments are required');
  }

  const { getCostDatabase } = await import('../cost/index.js');
  const costDb = getCostDatabase();

  const model = args.model as string | undefined;
  const workflowId = args.workflow_id as string | undefined;
  const limit = (args.limit as number) || 100;

  // De-mock (MCP-01/02/03): report REAL spend from the usage ledger
  // (usage_costs + model_calls), not a sum of per-1k pricing rates.
  // Both ledgers carry the provider-reported cost_usd per call.
  const byModel = costDb.getRealSpendByModel({
    model,
    workflow_id: workflowId,
    limit,
  });
  const totals = costDb.getTotalRealSpend({ model, workflow_id: workflowId });

  // Derive blended effective cost-per-1k-tokens from real spend so
  // operators still get a normalized rate — computed from actuals,
  // never fabricated. Guard against divide-by-zero on a fresh ledger.
  const totalTokens = totals.total_input_tokens + totals.total_output_tokens;
  const effectiveCostPer1k =
    totalTokens > 0 ? (totals.total_cost_usd / totalTokens) * 1000 : 0;
  const avgCostPerCall =
    totals.total_calls > 0 ? totals.total_cost_usd / totals.total_calls : 0;

  return JSON.stringify({
    source: 'usage_ledger', // real spend, not pricing rates
    total_cost_usd: totals.total_cost_usd,
    total_input_tokens: totals.total_input_tokens,
    total_output_tokens: totals.total_output_tokens,
    total_calls: totals.total_calls,
    distinct_models: totals.distinct_models,
    avg_cost_per_call_usd: avgCostPerCall,
    effective_cost_per_1k_usd: effectiveCostPer1k,
    by_model: byModel,
    note:
      totals.total_calls === 0
        ? 'No usage recorded yet — ledger is empty. Run a workflow to populate real spend.'
        : undefined,
  }, null, 2);
}

async function costOptimizationTool(args: ToolArgs): Promise<string> {
  if (!args) {
    throw new Error('Arguments are required');
  }

  const { CostOptimizer, getCostDatabase } = await import('../cost/index.js');
  const optimizer = new CostOptimizer();

  const budgetUsd = (args.budget_usd as number) || 1.0;
  const remainingTasks = (args.remaining_tasks as number) || 1;
  const currentModel = args.current_model as string;
  const workflowId = args.workflow_id as string | undefined;

  if (!currentModel) {
    throw new Error('current_model is required');
  }

  // De-mock (MCP-01/02/03): ground the optimizer in REAL spend instead
  // of the hardcoded current_cost: 0. When a workflow_id is supplied we
  // read its actual spend from the ledger; otherwise we use the spend
  // recorded for the current model. Falls back to 0 on a fresh ledger.
  const costDb = getCostDatabase();
  const currentCost = workflowId
    ? costDb.getTotalRealSpend({ workflow_id: workflowId }).total_cost_usd
    : costDb.getTotalRealSpend({ model: currentModel }).total_cost_usd;

  const recommendation = await optimizer.recommendAction({
    current_cost: currentCost,
    budget: budgetUsd,
    remaining_tasks: remainingTasks,
    current_model: currentModel,
    task_kind: 'general',
    use_case: 'general'
  });

  return JSON.stringify({
    ...recommendation,
    current_cost_usd: currentCost,
    budget_usd: budgetUsd,
    cost_source: workflowId ? 'workflow_ledger' : 'model_ledger',
  }, null, 2);
}

async function benchmarkListTool(args: ToolArgs): Promise<string> {
  if (!args) {
    throw new Error('Arguments are required');
  }

  const { getBenchmarkStore } = await import('../benchmark/index.js');
  const benchmarkStore = getBenchmarkStore();

  const useCase = args.use_case as string | undefined;
  const provider = args.provider as string | undefined;

  let benchmarks = benchmarkStore.getAllBenchmarks();

  if (useCase) {
    benchmarks = benchmarks.filter(b => b.use_case === useCase);
  }
  if (provider) {
    benchmarks = benchmarks.filter(b => b.provider === provider);
  }

  return JSON.stringify({
    total_benchmarks: benchmarks.length,
    benchmarks: benchmarks.slice(0, 20) // Return first 20 for preview
  }, null, 2);
}

async function benchmarkRunTool(args: ToolArgs): Promise<string> {
  if (!args) {
    throw new Error('Arguments are required');
  }

  const { BenchmarkRunner } = await import('../benchmark/index.js');
  const benchmarkRunner = new BenchmarkRunner();

  const suiteName = args.suite_name as string;
  const models = args.models as string[];
  const provider = (args.provider as string) || 'omniroute';
  const useCase = (args.use_case as string) || 'code';
  const callerPrompts = Array.isArray(args.test_prompts)
    ? (args.test_prompts as unknown[]).filter((p): p is string => typeof p === 'string')
    : undefined;

  if (!suiteName || !models || models.length === 0) {
    throw new Error('suite_name and models are required');
  }

  // De-mock (MCP-06/OPS-10): the provider call, cost_usd and latency_ms
  // produced below are REAL. quality_score is a heuristic placeholder
  // (see BenchmarkRunner.evaluateQuality) — surfaced as such here so
  // operators never read it as a measured benchmark.
  const prompts = (callerPrompts && callerPrompts.length > 0)
    ? callerPrompts
    : ['Write a function that adds two numbers'];

  const suite = {
    name: suiteName,
    use_cases: [useCase],
    test_cases: prompts.map((input, i) => ({
      id: `test-${i + 1}`,
      input,
      expected_quality: 0.8,
    })),
  };

  // Run suite for each model
  const allResults: import('../benchmark/index.js').BenchmarkRun[] = [];
  for (const model of models) {
    const results = await benchmarkRunner.runSuite(provider, model, suite);
    allResults.push(...results);
  }

  const realRuns = allResults.filter(r => r.success);
  const avgRealCost =
    realRuns.length > 0
      ? realRuns.reduce((s, r) => s + (r.cost_usd || 0), 0) / realRuns.length
      : 0;
  const avgLatency =
    realRuns.length > 0
      ? realRuns.reduce((s, r) => s + (r.latency_ms || 0), 0) / realRuns.length
      : 0;

  return JSON.stringify({
    suite: suiteName,
    use_case: useCase,
    models,
    total_runs: allResults.length,
    successful_runs: realRuns.length,
    // Real, measured aggregates from live provider calls.
    avg_cost_usd: avgRealCost,
    avg_latency_ms: avgLatency,
    // Explicit honesty about the quality dimension.
    quality_is_placeholder: true,
    quality_note:
      'quality_score is a heuristic placeholder (length/keyword checks), NOT a measured benchmark. ' +
      'cost_usd and latency_ms are real.',
    results: allResults.slice(0, 5), // Return first 5 results for preview
  }, null, 2);
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  omniforge_plan_workflow: planWorkflowTool,
  omniforge_run_workflow: runWorkflowTool,
  omniforge_get_workflow_status: getWorkflowStatusTool,
  omniforge_get_model_calls: getModelCallsTool,
  omniforge_get_context_bundle: getContextBundleTool,
  omniforge_get_architecture_contract: getArchitectureContractTool,
  omniforge_read_task_thread: readTaskThreadTool,
  omniforge_post_task_handoff: postTaskHandoffTool,
  omniforge_inspect_workflow_diff: inspectWorkflowDiffTool,
  omniforge_create_fix_task: createFixTaskTool,
  omniforge_request_architecture_review: requestArchitectureReviewTool,
  omniforge_request_product_review: requestProductReviewTool,
  omniforge_register_eval_case: registerEvalCaseTool,
  omniforge_list_eval_cases: listEvalCasesTool,
  omniforge_get_eval_run: getEvalRunTool,
  omniforge_list_workflows: listWorkflowsTool,
  omniforge_approve_gate: approveGateTool,
  omniforge_list_patterns: listPatternsTool,
  omniforge_save_pattern: savePatternTool,
  omniforge_export_pattern: exportPatternTool,
  omniforge_import_pattern: importPatternTool,
  omniforge_list_models: listModelsTool,
  omniforge_route_model: routeModelTool,
  omniforge_opencode_sync_models: opencodeSyncModelsTool,
  omniforge_set_hermes_model: setHermesModelTool,
  omniforge_set_config: setConfigTool,
  omniforge_read_file: readFileTool,
  omniforge_vault_write,
  omniforge_vault_read,
  omniforge_vault_list,
  omniforge_vault_delete,
  omniforge_vault_merge,
  omniforge_register_versioned_definition: registerVersionedDefinitionTool,
  omniforge_list_versioned_definitions: listVersionedDefinitionsTool,
  omniforge_replay_persona_version: replayPersonaVersionTool,
  omniforge_run_meta_workflow: runMetaWorkflowTool,
  omniforge_tail_cli: asJson(async (args) => tailCliTool(TailCliSchema.parse(args))),
  omniforge_task_await: (args) => omniforgeTaskAwait(TaskAwaitSchema.parse(args)),
  omniforge_task_cancel: (args) => omniforgeTaskCancel(TaskCancelSchema.parse(args)),
  omniforge_pin_versioned_definition: pinVersionedDefinitionTool,
  omniforge_builder_chat,
  omniforge_credential_create: asJson(handleCredentialCreate),
  omniforge_credential_get: asJson(handleCredentialGet),
  omniforge_credential_get_by_service: asJson(handleCredentialGetByService),
  omniforge_credential_list: asJson(handleCredentialList),
  omniforge_credential_update: asJson(handleCredentialUpdate),
  omniforge_credential_delete: asJson(handleCredentialDelete),
  omniforge_credential_rotate: asJson(handleCredentialRotate),
  omniforge_credential_sync: asJson(handleCredentialSync),
  omniforge_credential_sync_status: asJson(handleCredentialSyncStatus),
  omniforge_credential_audit_log: asJson(handleCredentialAuditLog),
  omniforge_credential_validate_routing: asJson(handleCredentialValidateRouting),
  omniforge_cost_analytics: costAnalyticsTool,
  omniforge_cost_optimization: costOptimizationTool,
  omniforge_benchmark_list: benchmarkListTool,
  omniforge_benchmark_run: benchmarkRunTool,
};

export function createOmniforgeServer(): Server {
  const server = new Server(
    { name: 'omniforge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Native advisor tools (omniforge_<advisor_name>) route through the
    // advisor registry instead of PAL stdio.
    const handler = Object.hasOwn(TOOL_HANDLERS, name)
      ? TOOL_HANDLERS[name]
      : isAdvisorToolName(name)
        ? (a: ToolArgs) => runAdvisorTool(name, a)
        : undefined;
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      const text = await handler(args);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  // stdout must carry only JSON-RPC frames; redirect all console output to stderr
  const toStderr = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
  console.log = toStderr;
  console.warn = toStderr;
  console.info = toStderr;
  console.error = toStderr;

  const server = createOmniforgeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
