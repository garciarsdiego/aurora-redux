/**
 * EVALUATOR step executor — LLM-backed routing decision.
 *
 * Calls the configured LLM with task.evaluator_prompt plus a slice of
 * sharedState (keys listed in task.input_keys). The model must respond
 * with one of the keys in task.evaluator_route_map.
 *
 * Accepted response formats (tried in order):
 *   1. JSON object: {"decision":"label"[,"reasoning":"..."]}
 *   2. XML tag:     <DECISION>label</DECISION>
 *   3. Trimmed plain text matching a route key exactly
 *
 * Stores:
 *   sharedState[`_evaluator_decision_${task.id}`] = decision label
 *
 * Emits:
 *   { type: 'evaluator_decision', task_id, decision, target_step_id, reasoning }
 */

import type { DagTask } from '../../../types/index.js';
import {
  callOmnirouteWithUsage,
} from '../../../utils/omniroute-call.js';
import { getTaskModel } from '../../../utils/config.js';

export interface EvaluatorCtx {
  workflowId?: string;
  /** Override the LLM invoker for tests. */
  invoker?: (opts: {
    systemPrompt: string;
    userPrompt: string;
    model: string;
  }) => Promise<{ content: string }>;
  emitEvent?: (payload: Record<string, unknown>) => void | Promise<void>;
}

export interface EvaluatorResult {
  decision: string;
  target_step_id: string | null;
  reasoning: string;
}

const DECISION_JSON_RE = /"decision"\s*:\s*"([^"]+)"/;
const DECISION_XML_RE = /<DECISION>\s*([^<]+?)\s*<\/DECISION>/i;
const REASONING_JSON_RE = /"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function parseDecision(raw: string): { decision: string; reasoning: string } {
  // 1. JSON object
  const jsonMatch = DECISION_JSON_RE.exec(raw);
  if (jsonMatch) {
    const reasoningMatch = REASONING_JSON_RE.exec(raw);
    return {
      decision: jsonMatch[1].trim(),
      reasoning: reasoningMatch ? reasoningMatch[1] : '',
    };
  }

  // 2. XML tag
  const xmlMatch = DECISION_XML_RE.exec(raw);
  if (xmlMatch) {
    return { decision: xmlMatch[1].trim(), reasoning: '' };
  }

  // 3. Trimmed plain text
  return { decision: raw.trim(), reasoning: '' };
}

export async function executeEvaluator(
  task: DagTask,
  sharedState: Record<string, unknown>,
  ctx: EvaluatorCtx = {},
): Promise<EvaluatorResult> {
  const routeMap = task.evaluator_route_map ?? {};
  const validDecisions = Object.keys(routeMap);

  if (validDecisions.length === 0) {
    throw new Error(`evaluator task "${task.id}": evaluator_route_map is empty`);
  }

  const evaluatorPrompt = task.evaluator_prompt ?? '';

  // Build sharedState slice from input_keys
  const stateSlice: Record<string, unknown> = {};
  for (const key of task.input_keys ?? []) {
    if (Object.prototype.hasOwnProperty.call(sharedState, key)) {
      stateSlice[key] = sharedState[key];
    }
  }

  const systemPrompt = [
    'You are a routing evaluator. Based on the context provided, select exactly one decision label.',
    `Valid decisions: ${validDecisions.map((d) => JSON.stringify(d)).join(', ')}.`,
    'Respond in ONE of these formats:',
    '  {"decision":"<label>","reasoning":"<brief reason>"}',
    '  <DECISION><label></DECISION>',
    '  <label>   (plain text, exactly matching one valid decision)',
  ].join('\n');

  const userPrompt = [
    evaluatorPrompt,
    '',
    '--- State context ---',
    JSON.stringify(stateSlice, null, 2),
  ].join('\n');

  const model = getTaskModel();

  let rawContent: string;
  if (ctx.invoker) {
    const res = await ctx.invoker({ systemPrompt, userPrompt, model });
    rawContent = res.content;
  } else {
    const res = await callOmnirouteWithUsage({ systemPrompt, userPrompt, model });
    rawContent = res.content;
  }

  const { decision: rawDecision, reasoning } = parseDecision(rawContent);

  // Validate decision against route map keys
  if (!Object.prototype.hasOwnProperty.call(routeMap, rawDecision)) {
    throw new Error(
      `evaluator task "${task.id}": LLM returned decision "${rawDecision}" ` +
        `which is not in evaluator_route_map. Valid: ${validDecisions.join(', ')}. ` +
        `Raw response: ${rawContent.slice(0, 300)}`,
    );
  }

  const decision = rawDecision;
  const target_step_id = routeMap[decision] ?? null;

  // Persist decision in sharedState
  sharedState[`_evaluator_decision_${task.id}`] = decision;

  await ctx.emitEvent?.({
    type: 'evaluator_decision',
    task_id: task.id,
    decision,
    target_step_id,
    reasoning,
  });

  return { decision, target_step_id, reasoning };
}
