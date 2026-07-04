/**
 * TransitionContext — explains why the current task was scheduled (Synapse pattern).
 * Built from the last completed upstream step and injected into worker prompts.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { Dag, Task } from '../../types/index.js';
import { safeParseJson } from '../../utils/safe-parse-json.js';

export type TransitionOriginType =
  | 'entry'
  | 'linear'
  | 'evaluator'
  | 'loop'
  | 'human_response';

export interface TransitionContext {
  origin_type: TransitionOriginType;
  execution_number: number;
  from_step_id?: string;
  from_step_name?: string;
  from_agent_name?: string;
  routing_decision?: string;
  routing_reasoning?: string;
  loop_iteration?: number;
  loop_total?: number;
  human_response_key?: string;
}

export const transitionContextStorage = new AsyncLocalStorage<TransitionContext | undefined>();

export function getTransitionContextFromALS(): TransitionContext | undefined {
  return transitionContextStorage.getStore();
}

/** Minimal {@link Dag} view from live runner rows (only fields needed for transition logic). */
export function dagFromTasks(tasks: Task[]): Dag {
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      depends_on: [...t.depends_on],
    })) as Dag['tasks'],
  };
}

function parseEvaluatorOutput(outputJson: string | null): { decision?: string; reasoning?: string } {
  if (!outputJson?.trim()) return {};
  try {
    const o = JSON.parse(outputJson) as Record<string, unknown>;
    const decision = typeof o.decision === 'string' ? o.decision : undefined;
    const reasoning = typeof o.reasoning === 'string' ? o.reasoning : undefined;
    if (decision || reasoning) return { decision, reasoning };
  } catch {
    /* fall through */
  }
  const raw = outputJson.trim();
  const dm = /"decision"\s*:\s*"([^"]+)"/.exec(raw);
  const rm = /"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  return {
    decision: dm?.[1],
    reasoning: rm?.[1],
  };
}

/**
 * @param task — task about to run
 * @param taskHistory — full workflow task list with current statuses (same convention as `run.task_history`)
 * @param dag — validated DAG (may be derived via {@link dagFromTasks})
 * @param db — optional Database handle for audit-event emission on malformed input_json
 * @param workflowId — optional workflow ID for audit-event correlation
 */
export function buildTransitionContext(
  task: Task,
  taskHistory: Task[],
  dag: Dag,
  db?: Database.Database,
  workflowId?: string,
): TransitionContext {
  void dag;
  const byId = new Map(taskHistory.map((t) => [t.id, t]));
  const completed = taskHistory.filter((t) => t.status === 'completed');
  const execution_number = completed.length + 1;

  let loop_iteration: number | undefined;
  let loop_total: number | undefined;
  const inj = safeParseJson<Record<string, unknown>>(task.input_json, {
    where: 'build_transition_context',
    taskId: task.id,
    ...(db ? { db } : {}),
    ...(workflowId ? { workflowId } : {}),
  });
  if (inj) {
    if (typeof inj['_loop_current_iteration'] === 'number') {
      loop_iteration = inj['_loop_current_iteration'];
    }
    if (typeof inj['_loop_total'] === 'number') {
      loop_total = inj['_loop_total'];
    }
    if (typeof inj['human_response_key'] === 'string' && inj['human_response_key'].length > 0) {
      return {
        origin_type: 'human_response',
        execution_number,
        human_response_key: inj['human_response_key'],
      };
    }
  }

  if (loop_iteration !== undefined) {
    return {
      origin_type: 'loop',
      execution_number,
      loop_iteration,
      loop_total,
    };
  }

  if (task.depends_on.length === 0) {
    return { origin_type: 'entry', execution_number };
  }

  const preds = task.depends_on.map((id) => byId.get(id)).filter((p): p is Task => Boolean(p));
  const evalPreds = preds.filter((p) => p.kind === 'evaluator' && p.status === 'completed');
  const evalPred = evalPreds[evalPreds.length - 1];

  if (evalPred) {
    const { decision, reasoning } = parseEvaluatorOutput(evalPred.output_json);
    return {
      origin_type: 'evaluator',
      execution_number,
      from_step_id: evalPred.id,
      from_step_name: evalPred.name,
      routing_decision: decision,
      routing_reasoning: reasoning,
    };
  }

  const primary = preds[preds.length - 1];
  return {
    origin_type: 'linear',
    execution_number,
    from_step_id: primary?.id,
    from_step_name: primary?.name,
  };
}

export function formatTransitionPrefix(ctx: TransitionContext): string {
  const lines: string[] = [
    '### Transition context',
    '',
    `- origin_type: ${ctx.origin_type}`,
    `- execution_number: ${ctx.execution_number}`,
  ];
  if (ctx.from_step_id) lines.push(`- from_step_id: ${ctx.from_step_id}`);
  if (ctx.from_step_name) lines.push(`- from_step_name: ${ctx.from_step_name}`);
  if (ctx.from_agent_name) lines.push(`- from_agent_name: ${ctx.from_agent_name}`);
  if (ctx.routing_decision) lines.push(`- routing_decision: ${ctx.routing_decision}`);
  if (ctx.routing_reasoning) lines.push(`- routing_reasoning: ${ctx.routing_reasoning}`);
  if (ctx.loop_iteration !== undefined) {
    lines.push(
      `- loop_iteration: ${ctx.loop_iteration}${ctx.loop_total !== undefined ? ` / ${ctx.loop_total}` : ''}`,
    );
  }
  if (ctx.human_response_key) lines.push(`- human_response_key: ${ctx.human_response_key}`);
  lines.push('', 'Use this to stay aligned with why this task was scheduled.', '');
  return lines.join('\n');
}
