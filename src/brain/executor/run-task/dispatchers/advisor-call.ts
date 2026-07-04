import type Database from 'better-sqlite3';
import type { Task } from '../../../../types/index.js';
import { consumeVersionedDefinition } from '../versioned-definition.js';

// Kind-specific preprocessing for `task.kind === 'pal_call'` (advisor call).
// Consumes the advisor.<name> versioned-definition pin so audits can replay
// the exact spec the runtime used. The advisor itself reads from its module
// registry today; the event + usage row are the contract for now. A
// follow-up sprint can thread the spec into the advisor when overrides are
// needed at runtime.
// The versioned-registry's name regex allows [A-Za-z0-9._-] only (no
// colons), so we use a dotted convention: 'advisor.<name>'.
export function dispatchAdvisorCallPrep(params: {
  db: Database.Database;
  task: Task;
  workspace: string;
  workflowId: string;
}): void {
  const { db, task, workspace, workflowId } = params;
  if (typeof task.executor_hint !== 'string') return;
  const advisorHint = task.executor_hint;
  const advisorName = advisorHint.startsWith('advisor:')
    ? advisorHint.slice('advisor:'.length).trim()
    : advisorHint.startsWith('pal:')
      ? advisorHint.slice('pal:'.length).trim()
      : null;
  if (advisorName && /^[A-Za-z0-9._-]+$/.test(advisorName)) {
    consumeVersionedDefinition(db, {
      workspace,
      kind: 'agent',
      name: `advisor.${advisorName}`,
      workflowId,
      taskId: task.id,
      role: 'advisor',
    });
  }
}
