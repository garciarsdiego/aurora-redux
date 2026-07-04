import type Database from 'better-sqlite3';
import type { Task } from '../../../../types/index.js';
import { ensureToolPolicyApproval } from '../tool-policy-approval.js';

// Kind-specific preprocessing for `task.kind === 'tool_call'`.
// Delegates to the existing tool-policy-approval module which handles HITL
// gating for `tool_call` tasks that require operator approval.
export async function dispatchToolCallPrep(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  workspace: string;
  objective: string;
  autoApprove: boolean;
  doHitl: (info: import('../../../../hitl/cli.js').HitlPromptInfo) => Promise<'approve' | 'reject'>;
  allTasks?: Task[];
  forceHitlPrompt: boolean;
}): Promise<void> {
  const {
    db,
    task,
    workflowId,
    workspace,
    objective,
    autoApprove,
    doHitl,
    allTasks,
    forceHitlPrompt,
  } = params;
  await ensureToolPolicyApproval(
    db,
    task,
    workflowId,
    workspace,
    objective,
    autoApprove,
    doHitl,
    allTasks,
    forceHitlPrompt,
  );
}
