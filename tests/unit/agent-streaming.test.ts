/**
 * Wave 3.E: streaming agent outputs.
 *
 * Covers:
 *   - When persona.streaming === false (default), invokeStream is ignored
 *     and the runner uses the standard invoke. No streaming events fire.
 *   - When persona.streaming === true AND options.invokeStream is supplied,
 *     the runner consumes the generator, emits agent_streaming_start /
 *     agent_streaming_chunk / agent_streaming_end events, and accumulates
 *     the full string for downstream validation.
 *   - Schema validation runs on the accumulated string the same way it
 *     would on the non-streaming path.
 *   - When persona.streaming === true but options.invokeStream is NOT
 *     supplied, the runner uses callOmnirouteStream as the default stream
 *     invoker.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../src/utils/omniroute-stream.js', () => ({
  callOmnirouteStream: vi.fn(async function* () {
    yield '{"reply":"Streaming plan';
    yield ' is ready.","action":"ask_clarification"';
    yield ',"clarification_questions":["What output format should I optimize for?"]}';
  }),
}));

import {
  createInMemoryContext,
  runAgent,
  type AgentInvoker,
  type AgentStreamInvoker,
} from '../../src/v2/agents/runner.js';
import { BUILDER_CONVERSATIONAL_PERSONA } from '../../src/v2/agents/personas/builder_conversational.js';
import { WORKER_LLM_CALL_PERSONA } from '../../src/v2/agents/personas/worker_llm_call.js';
import type { AgentPersona } from '../../src/v2/agents/types.js';
import { callOmnirouteStream } from '../../src/utils/omniroute-stream.js';

interface StreamingInput { topic: string }
interface StreamingOutput { result: string }

const STREAMING_PERSONA: AgentPersona<StreamingInput, StreamingOutput> = {
  id: 'streaming.test',
  version: '1.0.0',
  name: 'Streaming Test Persona',
  identity: 'I am a streaming test persona.',
  mission: 'Echo the topic via streaming chunks.',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  hardRules: [],
  forbidden: [],
  ambiguityProtocol: [],
  tools: [],
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: 'Topic: ${INPUT.topic}',
  failureModes: [],
  streaming: true,
};

const NON_STREAMING_PERSONA: AgentPersona<StreamingInput, StreamingOutput> = {
  ...STREAMING_PERSONA,
  id: 'non-streaming.test' as AgentPersona<StreamingInput, StreamingOutput>['id'],
  streaming: false,
};

async function* yieldChunks(deltas: string[]): AsyncGenerator<string, void, void> {
  for (const d of deltas) yield d;
}

describe('runAgent + streaming (Wave 3.E)', () => {
  it('emits start/chunk/end events and accumulates output when streaming opts in', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });

    const invokeStream: AgentStreamInvoker = () =>
      yieldChunks(['{"res', 'ult":"', 'hello"}']);
    const fallbackInvoke: AgentInvoker = async () => '{"result":"unused"}';

    const out = await runAgent(STREAMING_PERSONA, { topic: 'demo' }, ctx, {
      invoke: fallbackInvoke,
      invokeStream,
      parseJson: true,
    });
    expect(out.result).toBe('hello');

    const types = ctx.events.map((e) => e.event);
    const startIdx = types.indexOf('agent_streaming_start');
    const endIdx = types.indexOf('agent_streaming_end');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    const chunks = ctx.events.filter((e) => e.event === 'agent_streaming_chunk');
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.payload['chunk'])).toEqual(['{"res', 'ult":"', 'hello"}']);
    expect(chunks[2]?.payload['cumulative_chars']).toBe('{"result":"hello"}'.length);
    expect(chunks[2]?.payload['seq']).toBe(3);

    const endPayload = ctx.events[endIdx]!.payload as Record<string, unknown>;
    expect(endPayload['total_chars']).toBe('{"result":"hello"}'.length);
    expect(endPayload['total_chunks']).toBe(3);
    expect(typeof endPayload['duration_ms']).toBe('number');
    expect(typeof endPayload['ttft_ms']).toBe('number');
  });

  it('does NOT stream when persona.streaming === false, even if invokeStream is supplied', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });
    let invokeStreamCalled = false;
    const invokeStream: AgentStreamInvoker = () => {
      invokeStreamCalled = true;
      return yieldChunks(['ignored']);
    };
    const invoke: AgentInvoker = async () => '{"result":"non-streamed"}';

    const out = await runAgent(NON_STREAMING_PERSONA, { topic: 'demo' }, ctx, {
      invoke,
      invokeStream,
      parseJson: true,
    });
    expect(out.result).toBe('non-streamed');
    expect(invokeStreamCalled).toBe(false);
    expect(ctx.events.find((e) => e.event === 'agent_streaming_start')).toBeUndefined();
    expect(ctx.events.find((e) => e.event === 'agent_streaming_chunk')).toBeUndefined();
  });

  it('uses callOmnirouteStream by default when a real persona opts into streaming', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });

    const out = await runAgent(
      BUILDER_CONVERSATIONAL_PERSONA,
      {
        workspace: 'internal',
        session_id: 'sess_stream',
        conversation: [{ role: 'user', text: 'Plan a long-form report workflow.' }],
        available_models: [{ model_id: 'cc/claude-sonnet-4-6', family: 'claude' }],
        available_clis: ['cli:codex'],
      },
      ctx,
      {
        invoke: async () => {
          throw new Error('non-streaming invoke should not be used for streaming personas');
        },
        modelOverride: 'cc/claude-sonnet-4-6',
        parseJson: true,
      },
    );

    expect(out.action).toBe('ask_clarification');
    expect(callOmnirouteStream).toHaveBeenCalledTimes(1);
    expect(ctx.events.filter((e) => e.event === 'agent_streaming_chunk')).toHaveLength(3);
  });

  it('keeps the selected verbose personas opted into streaming', () => {
    expect(BUILDER_CONVERSATIONAL_PERSONA.streaming).toBe(true);
    expect(WORKER_LLM_CALL_PERSONA.streaming).toBe(true);
  });

  it('schema validation operates on the accumulated streamed output', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });
    // Emit JSON missing the required `result` field — should hit the
    // existing one-shot retry, then fall back to invoke for the retry.
    const badStream: AgentStreamInvoker = () => yieldChunks(['{}']);
    const retryInvoke: AgentInvoker = async () => '{"result":"recovered"}';

    const out = await runAgent(STREAMING_PERSONA, { topic: 'demo' }, ctx, {
      invoke: retryInvoke,
      invokeStream: badStream,
      parseJson: true,
    });
    expect(out.result).toBe('recovered');
    // The streaming start/end fired exactly once for the first attempt.
    expect(ctx.events.filter((e) => e.event === 'agent_streaming_start')).toHaveLength(1);
    expect(ctx.events.filter((e) => e.event === 'agent_streaming_end')).toHaveLength(1);
  });

  it('drops empty / non-string deltas and keeps seq numbers contiguous', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });
    async function* deltas(): AsyncGenerator<string, void, void> {
      yield '{"res';
      yield ''; // empty — should be skipped
      yield 'ult"';
      yield ':"';
      yield 'ok"';
      yield ''; // skipped
      yield '}';
    }
    const invokeStream: AgentStreamInvoker = () => deltas();

    const out = await runAgent(STREAMING_PERSONA, { topic: 'demo' }, ctx, {
      invoke: async () => '{"result":"unused"}',
      invokeStream,
      parseJson: true,
    });
    expect(out.result).toBe('ok');
    const chunks = ctx.events.filter((e) => e.event === 'agent_streaming_chunk');
    expect(chunks).toHaveLength(5);
    expect(chunks.map((c) => c.payload['seq'])).toEqual([1, 2, 3, 4, 5]);
  });
});
