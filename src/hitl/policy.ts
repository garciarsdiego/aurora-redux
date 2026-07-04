import type { HitlConfig } from './config.js';
import type { Task } from '../types/index.js';

function matchesField(value: string | null, rule: string | string[] | undefined): boolean {
  if (rule === undefined) return true;
  if (value === null) return false;
  return Array.isArray(rule) ? rule.includes(value) : value === rule;
}

export function matchesAutoApprovePolicy(
  task: Task,
  config: HitlConfig | null,
  workspace: string,
): boolean {
  const policy = config?.auto_approve_if;
  if (!policy) return false;
  return (
    matchesField(task.kind, policy.kind) &&
    matchesField(workspace, policy.workspace) &&
    matchesField(task.model, policy.model)
  );
}
