import type Database from 'better-sqlite3';
import type { Task } from '../../../../types/index.js';
import { consumeVersionedDefinition } from '../versioned-definition.js';

// Kind-specific preprocessing for `task.kind === 'llm_call'`.
// Consumes the worker.llm_call versioned-definition pin so audits can replay
// the exact spec the runtime used. The advisor itself reads from its module
// registry today; the event + usage row are the contract for now.
export function dispatchLlmCallPrep(params: {
  db: Database.Database;
  task: Task;
  workspace: string;
  workflowId: string;
}): void {
  const { db, task, workspace, workflowId } = params;
  // Worker llm_call persona pin lookup. The 'worker.llm_call' name reserves
  // a slot for future operator-pinned worker persona overrides.
  consumeVersionedDefinition(db, {
    workspace,
    kind: 'agent',
    name: 'worker.llm_call',
    workflowId,
    taskId: task.id,
    role: 'worker_llm_call',
  });
}
