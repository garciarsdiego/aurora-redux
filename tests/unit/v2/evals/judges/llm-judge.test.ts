import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMJudge } from '../../../../../dist/v2/evals/judges/llm-judge.js';
import type { TestCase } from '../../../../../dist/v2/evals/types.js';

// Mock the omniroute-call module
vi.mock('../../../../../dist/utils/omniroute-call.js', () => ({
  callOmnirouteWithUsage: vi.fn(),
}));

import { callOmnirouteWithUsage } from '../../../../../dist/utils/omniroute-call.js';

describe('LLMJudge', () => {
  const createTestCase = (input: unknown, expected: unknown): TestCase<unknown, unknown> => ({
    id: 'test-1',
    workspace: 'test',
    suite: 'custom',
    name: 'Test case',
    input,
    expected,
    created_at: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should evaluate with LLM and return score', async () => {
    const mockResponse = {
      content: JSON.stringify({ score: 0.8, reason: 'Good response' }),
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      temperature: 0.2,
      max_tokens: 1024,
      cache: false,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0.8);
    expect(result.reason).toContain('Good response');
    expect(result.cost_usd).toBe(0.001);
    expect(result.cache_hit).toBe(false);
    expect(callOmnirouteWithUsage).toHaveBeenCalledTimes(1);
  });

  it('should parse JSON from markdown code blocks', async () => {
    const mockResponse = {
      content: '```json\n{"score": 0.9, "reason": "Excellent"}\n```',
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0.9);
  });

  it('should handle multiple iterations with mean aggregation', async () => {
    const mockResponses = [
      {
        content: JSON.stringify({ score: 0.7, reason: 'First iteration' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
      {
        content: JSON.stringify({ score: 0.9, reason: 'Second iteration' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
    ];

    vi.mocked(callOmnirouteWithUsage)
      .mockResolvedValueOnce(mockResponses[0])
      .mockResolvedValueOnce(mockResponses[1]);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 2,
      aggregate: 'mean',
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0.8); // (0.7 + 0.9) / 2
    expect(result.reason).toContain('Aggregated from 2 iterations');
    expect(result.cost_usd).toBe(0.002);
  });

  it('should handle multiple iterations with median aggregation', async () => {
    const mockResponses = [
      {
        content: JSON.stringify({ score: 0.5, reason: 'First' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
      {
        content: JSON.stringify({ score: 0.8, reason: 'Second' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
      {
        content: JSON.stringify({ score: 0.9, reason: 'Third' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
    ];

    vi.mocked(callOmnirouteWithUsage)
      .mockResolvedValueOnce(mockResponses[0])
      .mockResolvedValueOnce(mockResponses[1])
      .mockResolvedValueOnce(mockResponses[2]);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 3,
      aggregate: 'median',
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0.8); // Median of [0.5, 0.8, 0.9]
  });

  it('should handle multiple iterations with min aggregation', async () => {
    const mockResponses = [
      {
        content: JSON.stringify({ score: 0.7, reason: 'First' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
      {
        content: JSON.stringify({ score: 0.9, reason: 'Second' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      },
    ];

    vi.mocked(callOmnirouteWithUsage)
      .mockResolvedValueOnce(mockResponses[0])
      .mockResolvedValueOnce(mockResponses[1]);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 2,
      aggregate: 'min',
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0.7); // Min of [0.7, 0.9]
  });

  it('should cache results when enabled', async () => {
    const mockResponse = {
      content: JSON.stringify({ score: 0.8, reason: 'Cached' }),
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: true,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const input = {
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    };

    // First call - should hit Omniroute
    const result1 = await judge.evaluate(input);
    expect(result1.cache_hit).toBe(false);
    expect(callOmnirouteWithUsage).toHaveBeenCalledTimes(1);

    // Second call - should hit cache
    const result2 = await judge.evaluate(input);
    expect(result2.cache_hit).toBe(true);
    expect(result2.score).toBe(0.8);
    expect(callOmnirouteWithUsage).toHaveBeenCalledTimes(1); // Still 1, not called again
  });

  it('should soft-fail on LLM error', async () => {
    vi.mocked(callOmnirouteWithUsage).mockRejectedValue(new Error('LLM error'));

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('LLM judge failed');
    expect(result.cost_usd).toBe(0);
  });

  it('should soft-fail on invalid JSON response', async () => {
    const mockResponse = {
      content: 'not valid json',
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('Failed to parse');
  });

  it('should soft-fail on invalid response schema', async () => {
    const mockResponse = {
      content: JSON.stringify({ score: 2, reason: 'Too high' }), // score > 1
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('LLM judge failed');
  });

  it('should handle partial failures in multi-iteration mode', async () => {
    vi.mocked(callOmnirouteWithUsage)
      .mockRejectedValueOnce(new Error('First failed'))
      .mockResolvedValueOnce({
        content: JSON.stringify({ score: 0.9, reason: 'Second succeeded' }),
        model_used: 'test-model',
        usage: { total_cost_usd: 0.001 },
      });

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 2,
      aggregate: 'mean',
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0.9); // Only second iteration succeeded
    expect(result.reason).toContain('Second succeeded');
  });

  it('should handle all iterations failing', async () => {
    vi.mocked(callOmnirouteWithUsage).mockRejectedValue(new Error('All failed'));

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 3,
      aggregate: 'mean',
    });

    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('All LLM judge iterations failed');
  });

  it('should use default config values', async () => {
    const mockResponse = {
      content: JSON.stringify({ score: 0.8, reason: 'Good' }),
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
    });

    const testCase = createTestCase('hello', 'hello');
    await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(callOmnirouteWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0, // default
        model: 'test-model',
      }),
    );
  });

  it('should clear cache', async () => {
    const mockResponse = {
      content: JSON.stringify({ score: 0.8, reason: 'Cached' }),
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: true,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    const input = {
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    };

    // First call
    await judge.evaluate(input);
    expect(callOmnirouteWithUsage).toHaveBeenCalledTimes(1);

    // Clear cache
    judge.clearCache();

    // Second call - should hit Omniroute again
    await judge.evaluate(input);
    expect(callOmnirouteWithUsage).toHaveBeenCalledTimes(2);
  });

  it('should include evaluation steps in prompt', async () => {
    const mockResponse = {
      content: JSON.stringify({ score: 0.8, reason: 'Good' }),
      model_used: 'test-model',
      usage: { total_cost_usd: 0.001 },
    };

    vi.mocked(callOmnirouteWithUsage).mockResolvedValue(mockResponse);

    const judge = new LLMJudge({
      model: 'test-model',
      cache: false,
      iterations: 1,
    });

    const testCase = createTestCase('hello', 'hello');
    await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
      steps: ['Check for exact match', 'Check case sensitivity'],
    });

    expect(callOmnirouteWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining('Evaluation Steps'),
      }),
    );
  });
});