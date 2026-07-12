import { resolve } from 'node:path';
import '../v2/tools/core/index.js';
import { resolveTool, isToolAllowed, type ToolContext } from '../v2/tools/registry.js';
import { insertEvent } from '../db/persist.js';
import { evaluateToolPolicy, parseToolPolicySpec } from '../v2/governance/policy-engine.js';
import { getActiveVersionedDefinition } from '../v2/governance/versioned-registry.js';
import { initDb } from '../db/client.js';
import { getDbPath, getToolPolicyName } from '../utils/config.js';
import type { Task } from '../types/index.js';
import {
  startTraceSpan,
  endTraceSpan,
  spanContextStorage,
} from '../v2/observability/tracing.js';
import { evaluateActionGate } from '../v2/security/action-gate.js';

// Local helper — open the configured DB, run `fn`, always close. The
// open/try/finally/close pattern appeared three times in this file;
// centralising it removes the risk of a future path forgetting the close.
function withDb<T>(fn: (db: ReturnType<typeof initDb>) => T): T {
  const db = initDb(getDbPath());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function loadConfiguredToolPolicy(workspace: string): unknown | undefined {
  const policyName = getToolPolicyName();
  if (!policyName) return undefined;

  return withDb((db) => {
    const definition = getActiveVersionedDefinition(db, {
      workspace,
      kind: 'policy',
      name: policyName,
    });
    if (!definition) {
      throw new Error(`Configured tool policy '${policyName}' is not pinned for workspace '${workspace}'`);
    }
    return definition.spec;
  });
}

export async function runToolCallTask(task: Task, signal?: AbortSignal): Promise<string> {
  // EXEC-04 / BRAIN-03: bail before doing any work if the workflow was already
  // cancelled. Throw a typed AbortError so the retry loop's isAbortError() path
  // (src/brain/executor/run-task/cancel.ts) treats this as a cancel, not a
  // retryable failure.
  if (signal?.aborted) {
    const err = new Error(`tool_call '${task.name}' cancelled before dispatch`);
    err.name = 'AbortError';
    throw err;
  }

  // Malformed input_json must still FAIL the task (silently running the tool
  // with empty args would change behavior) — but rethrow with task context
  // instead of a bare SyntaxError that identifies nothing.
  let inputCtx: Record<string, unknown>;
  try {
    inputCtx = JSON.parse(task.input_json ?? '{}') as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`tool_call '${task.name}' has malformed input_json: ${msg}`);
  }
  const rawToolName = inputCtx['tool_name'];
  const toolName = (typeof rawToolName === 'string' ? rawToolName : undefined) ?? task.tool_name ?? '';
  if (!toolName) throw new Error(`tool_call task '${task.name}' has no tool_name`);
  const rawArgs = inputCtx['args'];
  const args = rawArgs !== null && typeof rawArgs === 'object'
    ? rawArgs as Record<string, unknown>
    : {};

  // WS3 — per-task tool allowlist. When the task declares `allowed_tools`, deny
  // any tool outside it BEFORE resolution/execution (auto-deny the rest). This
  // is the scoping substrate for unattended / sub-agent / constrained runs.
  // Absent => inherit-all (no behaviour change for existing tasks).
  const allowedTools = Array.isArray(inputCtx['allowed_tools'])
    ? (inputCtx['allowed_tools'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined;
  if (!isToolAllowed(toolName, allowedTools)) {
    withDb((db) => {
      insertEvent(db, {
        workflow_id: task.workflow_id,
        task_id: task.id,
        type: 'tool_blocked_by_allowlist',
        payload: { tool: toolName, allowed_tools: allowedTools },
      });
    });
    throw new Error(
      `tool_call '${toolName}' denied: not in this task's allowed_tools [${(allowedTools ?? []).join(', ')}]`,
    );
  }

  const tool = resolveTool(toolName);
  const parsed = tool.argsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `tool_call '${toolName}' args validation failed: ${parsed.error.message}`,
    );
  }

  // Workspace-scoped context — confines tool side effects to runs/<wfId>/.
  // Workspace name is sourced from the task row (executor sets task.workspace
  // when it materialises the DAG). Falls back to 'internal' if absent so
  // legacy tasks without workspace metadata still execute under the safest
  // default rather than the project root.
  const workspace = task.workspace
    ?? (typeof inputCtx['workspace'] === 'string' ? inputCtx['workspace'] : undefined)
    ?? 'internal';
  const ctx: ToolContext = {
    workspace,
    workflowId: task.workflow_id,
    workspaceRoot: resolve('workspaces', workspace, 'runs', task.workflow_id),
    // EXEC-04: forward the composed cancel+timeout signal so bash/http-request
    // can abort in-flight. Only set when present to keep the field optional.
    ...(signal !== undefined ? { signal } : {}),
    // WS3: carry the allowlist into the tool's context so a tool that fans out
    // to sub-tools can re-apply the same scope (defense-in-depth).
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };

  const rawPolicy =
    inputCtx['tool_policy'] ??
    task.tool_policy ??
    loadConfiguredToolPolicy(workspace);
  if (rawPolicy !== undefined) {
    const policy = parseToolPolicySpec(rawPolicy);
    const decision = evaluateToolPolicy(policy, {
      toolName,
      workspace,
      workflowId: task.workflow_id,
    });
    const approvedByGate =
      decision.requiresApproval &&
      inputCtx['tool_policy_approved'] === true &&
      inputCtx['tool_policy_approved_tool'] === toolName;
    if (!decision.allowed && !approvedByGate) {
      throw new Error(`tool_call '${toolName}' blocked by policy: ${decision.reason}`);
    }
  }

  // Action gate check — classifies the tool into one of 5 categories and
  // queries the per-agent (or '__default__') policy from agent_action_policies.
  // If the DB is unavailable the gate falls back to 'allow' so it is never a
  // reliability blocker. 'require-approval' is in observe-only mode until the
  // HITL gate creation path is wired in a follow-up (Tier 2).
  withDb((gateDb) => {
    const gate = evaluateActionGate(toolName, '__default__', gateDb);
    if (gate.disposition === 'block') {
      throw new Error(`tool_call blocked by action gate [${gate.category}]: ${toolName}`);
    }
    // 'require-approval' is observe-only until Tier 2 HITL wiring.
    // Log to stderr so the bypassed policy is observable without a DB write on the hot path.
    // Deferred: replace this with createHitlGate() when per-agent policies are
    // enforced. Tracked in Tier 0.5 backlog — see
    // docs/notes/2026-05-12-master-goal-plan-all-tiers.md (Tier D).
    if (gate.disposition === 'require-approval') {
      process.stderr.write(`[action-gate] observe-only: ${toolName} [${gate.category}] would require approval\n`);
    }
  });

  const spanCtx = spanContextStorage.getStore();
  let spanId: string | undefined;
  if (spanCtx) {
    try {
      const span = startTraceSpan(spanCtx.db, {
        workflowId: task.workflow_id,
        taskId: task.id,
        parentSpanId: spanCtx.parentSpanId,
        name: `tool_call:${toolName}`,
        kind: 'tool_call',
        attributes: { tool_name: toolName, workspace },
      });
      spanId = span.id;
    } catch { /* tracing must not break execution */ }
  }

  const startMs = Date.now();
  try {
    const result = await tool.execute(parsed.data, ctx);
    if (spanId && spanCtx) {
      try {
        endTraceSpan(spanCtx.db, spanId, {
          status: 'ok',
          attributes: { duration_ms: Date.now() - startMs },
        });
      } catch { /* tracing must not break execution */ }
    }
    return JSON.stringify(result);
  } catch (err) {
    if (spanId && spanCtx) {
      try {
        endTraceSpan(spanCtx.db, spanId, {
          status: 'error',
          attributes: {
            error: (err as Error).message ?? String(err),
            duration_ms: Date.now() - startMs,
          },
        });
      } catch { /* tracing must not break execution */ }
    }
    throw err;
  }
}
