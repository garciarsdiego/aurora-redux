import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { insertEvent } from '../../../db/persist.js';
import { safeParseJson } from '../../../utils/safe-parse-json.js';
import { evaluateToolPolicy, parseToolPolicySpec } from '../../../v2/governance/policy-engine.js';
import { loadConfiguredToolPolicy } from '../../../executors/tool.js';
import { runHitlGate } from '../hitl-gate.js';

export async function ensureToolPolicyApproval(
  db: Database.Database,
  task: Task,
  wfId: string,
  workspace: string,
  objective: string,
  autoApprove: boolean,
  doHitl: (info: import('../../../hitl/cli.js').HitlPromptInfo) => Promise<'approve' | 'reject'>,
  allTasks?: Task[],
  forceHitlPrompt = false,
): Promise<void> {
  const inputCtx = safeParseJson<Record<string, unknown>>(task.input_json, {
    db,
    workflowId: wfId,
    taskId: task.id,
    where: 'ensure_tool_policy_approval',
  }) ?? {};

  const toolName = (inputCtx['tool_name'] as string | undefined) ?? task.tool_name ?? '';
  if (!toolName) return;
  if (
    inputCtx['tool_policy_approved'] === true &&
    inputCtx['tool_policy_approved_tool'] === toolName
  ) {
    return;
  }

  const rawPolicy =
    inputCtx['tool_policy'] ??
    task.tool_policy ??
    loadConfiguredToolPolicy(workspace);
  if (rawPolicy === undefined) return;

  const policy = parseToolPolicySpec(rawPolicy);
  const decision = evaluateToolPolicy(policy, {
    toolName,
    workspace,
    workflowId: wfId,
  });
  if (!decision.requiresApproval) return;

  const approvalTask: Task = {
    ...task,
    hitl: true,
    name: `Approve tool_call '${toolName}' for task '${task.name}'`,
  };
  await runHitlGate(db, approvalTask, wfId, workspace, objective, autoApprove, doHitl, allTasks, forceHitlPrompt);

  task.input_json = JSON.stringify({
    ...inputCtx,
    tool_policy_approved: true,
    tool_policy_approved_tool: toolName,
    tool_policy_approved_at: Date.now(),
  });
  try {
    db.prepare('UPDATE tasks SET input_json = ? WHERE id = ?').run(task.input_json, task.id);
  } catch { /* legacy schemas */ }
  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'tool_policy_approval_granted',
    payload: { tool_name: toolName, reason: decision.reason },
  });
}
