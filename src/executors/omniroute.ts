import type { Task } from '../types/index.js';
import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import { callOmnirouteStream } from '../utils/omniroute-stream.js';
import { getTaskModel, getUsePersonas } from '../utils/config.js';
import type { WorkflowProgressEvent } from '../brain/executor/types.js';
import {
  loadProviderMatrixCatalog,
  selectModel,
  type ModelCapability,
  type ModelRouteRequest,
} from '../v2/models/capability-registry.js';
import { getTransitionContextFromALS, formatTransitionPrefix } from '../v2/agents/transition-context.js';

// Priority: task.model (explicit) > executor_hint omniroute: prefix > global TASK_MODEL
export function resolveModel(task: Task): string {
  if (task.model) return task.model;
  if (task.executor_hint?.startsWith('omniroute:')) {
    return `claude/${task.executor_hint.slice('omniroute:'.length)}`;
  }
  const route = readModelRoute(task);
  if (route) {
    const selected = selectModel(loadProviderMatrixCatalog(), route);
    if (selected) return selected.model_id;
  }
  return getTaskModel();
}

function readModelRoute(task: Task): ModelRouteRequest | null {
  const raw = task.model_route ?? (() => {
    try {
      const ctx = JSON.parse(task.input_json ?? '{}') as Record<string, unknown>;
      return ctx['model_route'];
    } catch {
      return undefined;
    }
  })();
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as {
    use_case?: unknown;
    provider?: unknown;
    strategy?: unknown;
    required_capabilities?: unknown;
  };
  return {
    ...(typeof data.use_case === 'string' ? { useCase: data.use_case } : {}),
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
    ...(data.strategy === 'quality' || data.strategy === 'cost' || data.strategy === 'balanced'
      ? { strategy: data.strategy }
      : {}),
    ...(Array.isArray(data.required_capabilities)
      ? { requiredCapabilities: data.required_capabilities.filter((v): v is ModelCapability => typeof v === 'string') }
      : {}),
  };
}

function buildUserPrompt(task: Task): string {
  const lines: string[] = [`Task: ${task.name}`];

  const transition = getUsePersonas() ? getTransitionContextFromALS() : undefined;
  if (transition) {
    lines.push('', formatTransitionPrefix(transition));
  }

  if (task.acceptance_criteria) {
    lines.push(`Criteria: ${task.acceptance_criteria}`);
  }

  if (task.input_json) {
    try {
      const ctx = JSON.parse(task.input_json) as Record<string, unknown>;
      if (ctx['objective']) lines.push(`Context: ${ctx['objective']}`);
      if (ctx['execution_plan']) {
        lines.push(
          '',
          'EXECUTION PLAN TO EMIT:',
          'This context is the already-approved workflow DAG for this task.',
          'Do not critique, grade, approve, reject, or recommend revisions to the plan.',
          'Your deliverable is the concrete execution plan itself, so downstream tasks and reviewers can read it.',
          'Emit a markdown table with exactly this header:',
          '| id | name | kind | depends_on | deliverable |',
          'Then add a short "Execution order" list. Include every task from the JSON below, especially all subsequent tasks.',
          '',
          JSON.stringify(ctx['execution_plan'], null, 2),
        );
      }
      if (ctx['upstream_artifacts']) {
        lines.push('', 'UPSTREAM ARTIFACTS:', ctx['upstream_artifacts'] as string);
      }
      if (ctx['carry_from_upstream']) {
        lines.push('', 'CARRY FROM UPSTREAM (parsed handoff per parent):', ctx['carry_from_upstream'] as string);
      }
    } catch {
      // malformed input_json — skip silently
    }
  }

  if (task.refine_feedback) {
    lines.push('', 'PREVIOUS ATTEMPT FEEDBACK:', task.refine_feedback);
  }

  lines.push('', 'Complete this task clearly and concisely.');
  return lines.join('\n');
}

const SYSTEM_PROMPT =
  'You are a task executor in a multi-agent workflow. ' +
  'Complete each task with clear, structured output. ' +
  'Be concise and focus on the task criteria.';

export interface RunOmnirouteOpts {
  signal?: AbortSignal;
  onEvent?: (event: WorkflowProgressEvent) => void | Promise<void>;
  /**
   * Aurora-parity Wave 2 — opt-in cost-aware routing inputs, threaded by
   * executeTask only when OMNIFORGE_COST_ROUTER is on AND a budget cap yields
   * positive headroom. When present, callOmnirouteWithUsage downshifts to a
   * cheaper adequate model (and, with enforceBudget, hard-gates over budget).
   * Absent on every existing path → no behavior change.
   *
   * SCOPE (Wave 2): routing applies to the NON-STREAMING llm_call task path
   * only. The streaming branch below never forwards these (streaming is
   * uncommon and still covered by the pre-dispatch hard budget ceiling), and
   * decomposer/reviewer/consolidator call callOmnirouteWithUsage directly
   * without budget args so they are not routed. Widening is a follow-up.
   */
  budgetUsd?: number;
  taskType?: string;
  minQuality?: number;
  enforceBudget?: boolean;
  workflowId?: string;
  taskId?: string;
}

export async function runOmniRouteTask(
  task: Task,
  opts: RunOmnirouteOpts = {},
): Promise<string> {
  // Non-streaming path (default) — preserves exact behavior of all existing
  // callers (decomposer/reviewer/consolidator NEVER opt into stream).
  //
  // M1-W1-B fix for F-REL-1: forward the optional AbortSignal to the
  // underlying fetch via `callOmnirouteWithUsage`. Before this change the
  // signal was accepted at this layer but dropped — the adaptive supervisor's
  // defaultExecuteTurn(_signal) underscore-prefix was the visible smell.
  // Now a workflow cancel aborts an in-flight non-streaming LLM call within
  // one event-loop tick, preventing cost bleed up to the 300s server-side cap.
  if (!task.stream_output) {
    const start = Date.now();
    const result = await callOmnirouteWithUsage({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(task),
      model: resolveModel(task),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      // Aurora-parity Wave 2 — forward opt-in cost-routing inputs (present only
      // when executeTask threaded them; the streaming path below intentionally
      // never routes, matching the response-cache exclusion).
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
      ...(opts.taskType !== undefined ? { taskType: opts.taskType } : {}),
      ...(opts.minQuality !== undefined ? { minQuality: opts.minQuality } : {}),
      ...(opts.enforceBudget !== undefined ? { enforceBudget: opts.enforceBudget } : {}),
      ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    });
    task.model_used = result.model_used;
    task.input_tokens = result.usage?.input_tokens ?? null;
    task.output_tokens = result.usage?.output_tokens ?? null;
    task.llm_call_cost_usd = result.usage?.total_cost_usd ?? null;
    task.llm_call_latency_ms = Date.now() - start;
    return result.content;
  }

  // Streaming path (opt-in via task.stream_output, only valid for kind='llm_call').
  // Yields each delta as a chunk event; accumulates the full text into output_json
  // so reviewer/consolidator see the same string they'd see in non-stream mode.
  const startTs = Date.now();
  let firstChunkTs: number | null = null;
  const chunks: string[] = [];
  let cumulativeChars = 0;
  let seq = 0;
  let finalUsage: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number } | undefined;

  await opts.onEvent?.({
    type: 'task_streaming_start',
    workflow_id: task.workflow_id,
    payload: { task_id: task.id, task_name: task.name, ts: startTs },
  });

  try {
    for await (const delta of callOmnirouteStream({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(task),
      model: resolveModel(task),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      onUsage: (u) => { finalUsage = u; },
    })) {
      chunks.push(delta);
      cumulativeChars += delta.length;
      seq++;
      if (firstChunkTs === null) firstChunkTs = Date.now();

      await opts.onEvent?.({
        type: 'task_streaming_chunk',
        workflow_id: task.workflow_id,
        payload: {
          task_id: task.id,
          task_name: task.name,
          chunk: delta,
          cumulative_chars: cumulativeChars,
          seq,
        },
      });
    }
  } finally {
    const endTs = Date.now();
    const ttftMs = firstChunkTs !== null ? firstChunkTs - startTs : endTs - startTs;
    await opts.onEvent?.({
      type: 'task_streaming_end',
      workflow_id: task.workflow_id,
      payload: {
        task_id: task.id,
        task_name: task.name,
        total_chars: cumulativeChars,
        total_chunks: seq,
        duration_ms: endTs - startTs,
        ttft_ms: ttftMs,
        ...(finalUsage ? { usage: finalUsage } : {}),
        ...(finalUsage?.total_cost_usd !== undefined ? { cost_usd: finalUsage.total_cost_usd } : {}),
      },
    });
  }

  task.model_used = resolveModel(task);
  task.input_tokens = finalUsage?.input_tokens ?? null;
  task.output_tokens = finalUsage?.output_tokens ?? null;
  task.llm_call_cost_usd = finalUsage?.total_cost_usd ?? null;
  task.llm_call_latency_ms = Date.now() - startTs;
  return chunks.join('');
}
