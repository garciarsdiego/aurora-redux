import { describe, it, expect } from 'vitest';
import {
  mapChatMessagesToResponsesBody,
  normalizeResponsesContent,
  extractResponsesDelta,
} from '../../src/v2/omniroute-bridge/responses.js';

describe('mapChatMessagesToResponsesBody', () => {
  it('converts user/assistant messages to Responses API format', () => {
    const body = mapChatMessagesToResponsesBody({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
      model: 'gpt-4o',
      maxTokens: 1024,
    });
    expect(body.input).toHaveLength(2);
    expect(body.model).toBe('gpt-4o');
  });

  it('extracts system messages into instructions field', () => {
    const body = mapChatMessagesToResponsesBody({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Question' },
      ],
      model: 'gpt-4o',
    });
    expect(body.instructions).toContain('You are helpful');
    // system messages are excluded from input
    expect(body.input).toHaveLength(1);
  });

  it('returns well-formed body for empty messages', () => {
    const body = mapChatMessagesToResponsesBody({
      messages: [],
      model: 'gpt-4o',
    });
    expect(body.model).toBe('gpt-4o');
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input).toHaveLength(0);
  });

  it('sets max_output_tokens when maxTokens is provided', () => {
    const body = mapChatMessagesToResponsesBody({
      messages: [],
      model: 'gpt-4o',
      maxTokens: 2048,
    });
    expect(body.max_output_tokens).toBe(2048);
  });
});

describe('normalizeResponsesContent', () => {
  it('converts string content to input_text part array', () => {
    const parts = normalizeResponsesContent('hello world');
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0]?.type).toBe('input_text');
  });

  it('handles null/undefined gracefully', () => {
    expect(() => normalizeResponsesContent(null as unknown as string)).not.toThrow();
  });

  it('passes through already-normalized content', () => {
    const input = [{ type: 'input_text' as const, text: 'already normalized' }];
    const parts = normalizeResponsesContent(input as unknown as string);
    expect(parts[0]?.type).toBe('input_text');
  });
});

describe('extractResponsesDelta', () => {
  it('extracts text delta from output_text.delta event', () => {
    const delta = extractResponsesDelta({
      type: 'response.output_text.delta',
      delta: 'Hello',
    });
    expect(delta).toBe('Hello');
  });

  it('returns empty string for non-delta event type', () => {
    const delta = extractResponsesDelta({ type: 'response.done' });
    expect(delta).toBe('');
  });

  it('handles empty object without throwing', () => {
    expect(() => extractResponsesDelta({})).not.toThrow();
  });
});
