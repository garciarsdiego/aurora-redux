/**
 * Generic agent lifecycle runner.
 *
 * The runner is the only place that knows the order in which preHook → invoke
 * → output validation → postHook → emit happen. Personas declare their
 * contract; the runner executes it. This split is what lets us add new
 * personas (Refiner, Reviewer, …) without re-implementing the boilerplate.
 *
 * Design notes:
 *   - `invoke` is a strategy parameter, not hard-coded to Omniroute. Tests
 *     pass a stub; production wires in the real LLM call. This keeps the
 *     runner pure and unit-testable.
 *   - One automatic retry on output-schema failure with a stronger reminder.
 *     Beyond one retry, the runner gives up — the failover classifier decides
 *     what to do next.
 *   - The runner emits two events per run: `agent_started` and `agent_completed`
 *     (or `agent_rejected`). Personas can emit additional events from hooks.
 */

import { ZodError } from 'zod';

import { callOmnirouteStream } from '../../utils/omniroute-stream.js';
import { renderSystemPrompt } from './prompts/system_prompt_template.js';
import { enforcePersonaToolPermissions } from './permissions.js';
import {
  AgentInputError,
  AgentOutputError,
  AgentRejectedError,
  type AgentContext,
  type AgentPersona,
} from './types.js';

/**
 * Pluggable invoker. Production binds this to `callOmniroute`; tests inject a
 * deterministic stub. The string returned is whatever the model emitted —
 * usually JSON for structured personas.
 */
export interface AgentInvokeArgs {
  systemPrompt: string;
  /** User message, defaults to a marker that points the model at the system. */
  userPrompt?: string;
  model: string;
}

export type AgentInvoker = (args: AgentInvokeArgs) => Promise<string>;

/**
 * Wave 3.E — streaming invoker. Yields each delta the model emits and
 * resolves to the full accumulated string when the stream closes. The
 * runner emits `agent_streaming_chunk` events on each yield so live
 * consumers (dashboard, CLI printer) can render output as it arrives,
 * matching the existing task_streaming_* contract for llm_call tasks.
 */
export type AgentStreamInvoker = (
  args: AgentInvokeArgs,
) => AsyncIterable<string> | AsyncGenerator<string, void, void>;

export interface RunAgentOptions {
  /** Override the persona's default model — wins over persona.defaultModel. */
  modelOverride?: string;
  /** Pluggable invoker (LLM/tool caller). */
  invoke: AgentInvoker;
  /**
   * Wave 3.E — optional streaming invoker. When provided AND the persona
   * opts in via `streaming: true`, the runner consumes this generator
   * instead of calling `invoke`. Schema validation runs on the
   * accumulated string after the stream closes — same shape as the
   * non-streaming path.
   */
  invokeStream?: AgentStreamInvoker;
  /** When true, parse JSON from the raw output before schema validation. */
  parseJson?: boolean;
}

const DEFAULT_USER_PROMPT = 'Respond per the system contract above. No preamble, no markdown fences.';

export async function runAgent<I, O>(
  persona: AgentPersona<I, O>,
  rawInput: unknown,
  ctx: AgentContext,
  options: RunAgentOptions,
): Promise<O> {
  // ── 1. Validate input ─────────────────────────────────────────────────────
  const inputResult = persona.inputSchema.safeParse(rawInput);
  if (!inputResult.success) {
    ctx.log('error', `[${persona.id}] input invalid`, { issues: inputResult.error.issues });
    throw new AgentInputError(persona.id, inputResult.error.issues);
  }
  let input = inputResult.data;

  ctx.emit('agent_started', {
    agent_id: persona.id,
    persona_version: persona.version,
    workflow_id: ctx.workflowId,
    task_id: ctx.taskId,
    retry_count: ctx.retryCount,
  });

  // ── 2. preHook ────────────────────────────────────────────────────────────
  if (persona.preHook) {
    const r = await persona.preHook(input, ctx);
    if (r && typeof r === 'object' && 'skipWithResult' in (r as object)) {
      const short = (r as { skipWithResult: O }).skipWithResult;
      ctx.emit('agent_completed', {
        agent_id: persona.id,
        short_circuited: true,
        workflow_id: ctx.workflowId,
        task_id: ctx.taskId,
      });
      return short;
    }
    input = r as I;
  }

  enforcePersonaToolPermissions(
    persona.id,
    persona.tools,
    persona.permissions,
    ctx.emit.bind(ctx),
    { workflowId: ctx.workflowId, taskId: ctx.taskId },
  );

  // ── 3. Render system prompt ───────────────────────────────────────────────
  const systemPrompt = renderSystemPrompt(persona, input);
  const model = options.modelOverride ?? persona.defaultModel;
  if (!model && persona.tools.length === 0) {
    throw new AgentOutputError(
      persona.id,
      null,
      `Agent ${persona.id} has no defaultModel and no modelOverride was supplied`,
    );
  }

  // ── 4. Invoke ─────────────────────────────────────────────────────────────
  // Wave 3.E: streaming path — opt-in via persona.streaming + caller-provided
  // invokeStream. Falls back to the non-streaming invoke when either piece is
  // missing (default for every persona today). Output accumulates to the
  // same string the non-streaming path returns, so downstream schema
  // validation, postHooks, and the agent_completed event are unchanged.
  let rawOutput: string;
  const invokeStream: AgentStreamInvoker | undefined = persona.streaming
    ? options.invokeStream ?? ((args) => callOmnirouteStream({
        ...args,
        userPrompt: args.userPrompt ?? DEFAULT_USER_PROMPT,
      }))
    : undefined;
  if (persona.streaming && invokeStream) {
    rawOutput = await invokeWithStreaming(
      persona,
      invokeStream,
      {
        systemPrompt,
        userPrompt: DEFAULT_USER_PROMPT,
        model: model ?? '<no-model>',
      },
      ctx,
    );
  } else {
    rawOutput = await options.invoke({
      systemPrompt,
      userPrompt: options.parseJson ? DEFAULT_USER_PROMPT : DEFAULT_USER_PROMPT,
      model: model ?? '<no-model>',
    });
  }

  // ── 5. Validate output (parse + schema) ───────────────────────────────────
  let output: O;
  try {
    const parsed = options.parseJson ? safeParseJson(rawOutput) : rawOutput;
    output = persona.outputSchema.parse(parsed);
  } catch (firstErr) {
    // Retry once with stronger reminder.
    ctx.log('warn', `[${persona.id}] output schema failed, retrying with reminder`, {
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    });
    const reminder = buildSchemaReminder(persona.id, firstErr);
    rawOutput = await options.invoke({
      systemPrompt: `${systemPrompt}\n\n${reminder}`,
      userPrompt: 'Re-emit your previous response in compliance with the schema. JSON only.',
      model: model ?? '<no-model>',
    });
    try {
      const parsedRetry = options.parseJson ? safeParseJson(rawOutput) : rawOutput;
      output = persona.outputSchema.parse(parsedRetry);
    } catch (secondErr) {
      throw new AgentOutputError(
        persona.id,
        rawOutput,
        secondErr instanceof Error ? secondErr.message : String(secondErr),
      );
    }
  }

  // ── 6. postHook ───────────────────────────────────────────────────────────
  if (persona.postHook) {
    const r = await persona.postHook(input, output, ctx);
    if (r && typeof r === 'object' && 'rejectWithReason' in (r as object)) {
      const reject = r as { rejectWithReason: string; mode?: string };
      ctx.emit('agent_rejected', {
        agent_id: persona.id,
        reason: reject.rejectWithReason,
        mode: reject.mode,
        workflow_id: ctx.workflowId,
        task_id: ctx.taskId,
      });
      throw new AgentRejectedError(reject.rejectWithReason, persona.id, input, output, reject.mode);
    }
    output = r as O;
  }

  // ── 7. Emit completion ────────────────────────────────────────────────────
  ctx.emit('agent_completed', {
    agent_id: persona.id,
    persona_version: persona.version,
    workflow_id: ctx.workflowId,
    task_id: ctx.taskId,
  });

  return output;
}

/**
 * Wave 3.E — drive the streaming invoker, accumulate the full string, and
 * emit agent_streaming_start / _chunk / _end events as deltas arrive.
 * Returns the accumulated string so the rest of runAgent (schema validate,
 * postHook) operates on it identically to the non-streaming path.
 */
async function invokeWithStreaming<I, O>(
  persona: AgentPersona<I, O>,
  invokeStream: AgentStreamInvoker,
  args: AgentInvokeArgs,
  ctx: AgentContext,
): Promise<string> {
  const startTs = Date.now();
  let firstChunkTs: number | null = null;
  const parts: string[] = [];
  let cumulativeChars = 0;
  let seq = 0;

  ctx.emit('agent_streaming_start', {
    agent_id: persona.id,
    workflow_id: ctx.workflowId,
    task_id: ctx.taskId,
    ts: startTs,
  });

  try {
    for await (const delta of invokeStream(args)) {
      if (typeof delta !== 'string' || delta.length === 0) continue;
      parts.push(delta);
      cumulativeChars += delta.length;
      seq++;
      if (firstChunkTs === null) firstChunkTs = Date.now();
      ctx.emit('agent_streaming_chunk', {
        agent_id: persona.id,
        workflow_id: ctx.workflowId,
        task_id: ctx.taskId,
        chunk: delta,
        cumulative_chars: cumulativeChars,
        seq,
      });
    }
  } finally {
    const endTs = Date.now();
    const ttftMs = firstChunkTs !== null ? firstChunkTs - startTs : endTs - startTs;
    ctx.emit('agent_streaming_end', {
      agent_id: persona.id,
      workflow_id: ctx.workflowId,
      task_id: ctx.taskId,
      total_chars: cumulativeChars,
      total_chunks: seq,
      duration_ms: endTs - startTs,
      ttft_ms: ttftMs,
    });
  }

  return parts.join('');
}

function safeParseJson(text: string): unknown {
  // Strip common LLM contamination: markdown fences, leading prose, trailing prose.
  let cleaned = text.trim();
  // Strip ```json … ``` fences
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // Find the first balanced JSON object/array (covers some prose contamination)
  const firstBrace = cleaned.search(/[{[]/);
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);
  return JSON.parse(cleaned);
}

function buildSchemaReminder(agentId: string, err: unknown): string {
  if (err instanceof ZodError) {
    return [
      `=== SCHEMA VIOLATION (${agentId}) ===`,
      'Your previous response did not match the contract. Issues:',
      ...err.issues.slice(0, 8).map((i) => `- path=${i.path.join('.')}: ${i.message}`),
      'Re-emit STRICT JSON matching the contract above. First character MUST be `{`.',
    ].join('\n');
  }
  if (err instanceof SyntaxError) {
    return [
      `=== JSON PARSE FAILURE (${agentId}) ===`,
      `Your previous response was not valid JSON: ${err.message}`,
      'Re-emit STRICT JSON. No markdown fences, no prose preamble. First character MUST be `{`.',
    ].join('\n');
  }
  return [
    `=== OUTPUT REJECTED (${agentId}) ===`,
    err instanceof Error ? err.message : String(err),
    'Re-emit JSON matching the contract.',
  ].join('\n');
}

/** Test/utility helper: build a minimal AgentContext that records emits + logs. */
export function createInMemoryContext(overrides: Partial<AgentContext> = {}): AgentContext & {
  events: { event: string; payload: Record<string, unknown> }[];
  warnings: string[];
} {
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  return {
    retryCount: 0,
    ...overrides,
    events,
    warnings,
    emit(event, payload) {
      events.push({ event, payload });
    },
    warn(message) {
      warnings.push(message);
    },
    log() {
      // no-op in tests; pipe to console if needed via overrides
    },
  };
}
