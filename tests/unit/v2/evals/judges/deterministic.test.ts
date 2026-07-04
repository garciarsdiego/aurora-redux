import { describe, it, expect } from 'vitest';
import { ExactMatchJudge, RegexMatchJudge, SchemaMatchJudge } from '../../../../../dist/v2/evals/judges/deterministic.js';
import type { TestCase } from '../../../../../dist/v2/evals/types.js';

describe('ExactMatchJudge', () => {
  const judge = new ExactMatchJudge();

  const createTestCase = (input: unknown, expected: unknown): TestCase<unknown, unknown> => ({
    id: 'test-1',
    workspace: 'test',
    suite: 'custom',
    name: 'Test case',
    input,
    expected,
    created_at: Date.now(),
  });

  it('should match identical strings', async () => {
    const testCase = createTestCase('hello', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(1);
    expect(result.reason).toContain('matches');
    expect(result.cost_usd).toBe(0);
    expect(result.cache_hit).toBe(false);
  });

  it('should not match different strings', async () => {
    const testCase = createTestCase('hello', 'world');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'world',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('does not match');
  });

  it('should match identical objects (JSON)', async () => {
    const obj = { a: 1, b: 'test' };
    const testCase = createTestCase(obj, obj);
    const result = await judge.evaluate({
      testCase,
      output: obj,
      expected: obj,
      rubric: 'Exact match',
    });

    expect(result.score).toBe(1);
  });

  it('should not match different objects', async () => {
    const testCase = createTestCase({ a: 1 }, { a: 2 });
    const result = await judge.evaluate({
      testCase,
      output: { a: 1 },
      expected: { a: 2 },
      rubric: 'Exact match',
    });

    expect(result.score).toBe(0);
  });

  it('should support case-insensitive matching', async () => {
    const judge = new ExactMatchJudge({ caseSensitive: false });
    const testCase = createTestCase('HELLO', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'HELLO',
      expected: 'hello',
      rubric: 'Exact match',
    });

    expect(result.score).toBe(1);
  });

  it('should handle primitive types', async () => {
    const testCase = createTestCase(42, 42);
    const result = await judge.evaluate({
      testCase,
      output: 42,
      expected: 42,
      rubric: 'Exact match',
    });

    expect(result.score).toBe(1);
  });

  it('should handle null values', async () => {
    const testCase = createTestCase(null, null);
    const result = await judge.evaluate({
      testCase,
      output: null,
      expected: null,
      rubric: 'Exact match',
    });

    expect(result.score).toBe(1);
  });
});

describe('RegexMatchJudge', () => {
  const judge = new RegexMatchJudge();

  const createTestCase = (input: unknown, expected: unknown): TestCase<unknown, unknown> => ({
    id: 'test-1',
    workspace: 'test',
    suite: 'custom',
    name: 'Test case',
    input,
    expected,
    created_at: Date.now(),
  });

  it('should match regex pattern', async () => {
    const testCase = createTestCase('hello world', 'world');
    const result = await judge.evaluate({
      testCase,
      output: 'hello world',
      expected: 'world',
      rubric: 'world',
    });

    expect(result.score).toBe(1);
    expect(result.reason).toContain('matches');
  });

  it('should not match non-matching pattern', async () => {
    const testCase = createTestCase('hello world', 'goodbye');
    const result = await judge.evaluate({
      testCase,
      output: 'hello world',
      expected: 'goodbye',
      rubric: 'goodbye',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('does not match');
  });

  it('should support regex patterns', async () => {
    const testCase = createTestCase('test123', 'digits');
    const result = await judge.evaluate({
      testCase,
      output: 'test123',
      expected: 'digits',
      rubric: '\\d+',
    });

    expect(result.score).toBe(1);
  });

  it('should treat invalid regex as literal string', async () => {
    const testCase = createTestCase('hello [world]', 'literal');
    const result = await judge.evaluate({
      testCase,
      output: 'hello [world]',
      expected: 'literal',
      rubric: '[world]',
    });

    expect(result.score).toBe(1);
  });

  it('should support case-insensitive matching', async () => {
    const judge = new RegexMatchJudge({ caseInsensitive: false });
    const testCase = createTestCase('HELLO', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'HELLO',
      expected: 'hello',
      rubric: 'hello',
    });

    expect(result.score).toBe(0);
  });

  it('should match with case-insensitive flag', async () => {
    const judge = new RegexMatchJudge({ caseInsensitive: true });
    const testCase = createTestCase('HELLO', 'hello');
    const result = await judge.evaluate({
      testCase,
      output: 'HELLO',
      expected: 'hello',
      rubric: 'hello',
    });

    expect(result.score).toBe(1);
  });
});

describe('SchemaMatchJudge', () => {
  const createTestCase = (input: unknown, expected: unknown): TestCase<unknown, unknown> => ({
    id: 'test-1',
    workspace: 'test',
    suite: 'custom',
    name: 'Test case',
    input,
    expected,
    created_at: Date.now(),
  });

  it('should validate string schema', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase('hello', 'string');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'string',
      rubric: JSON.stringify({ type: 'string' }),
    });

    expect(result.score).toBe(1);
    expect(result.reason).toContain('matches');
  });

  it('should reject invalid string', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase(123, 'string');
    const result = await judge.evaluate({
      testCase,
      output: 123,
      expected: 'string',
      rubric: JSON.stringify({ type: 'string' }),
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('does not match');
  });

  it('should validate object schema', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase({ name: 'test', age: 25 }, 'object');
    const result = await judge.evaluate({
      testCase,
      output: { name: 'test', age: 25 },
      expected: 'object',
      rubric: JSON.stringify({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      }),
    });

    expect(result.score).toBe(1);
  });

  it('should reject invalid object', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase({ name: 'test', age: '25' }, 'object');
    const result = await judge.evaluate({
      testCase,
      output: { name: 'test', age: '25' },
      expected: 'object',
      rubric: JSON.stringify({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      }),
    });

    expect(result.score).toBe(0);
  });

  it('should validate array schema', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase([1, 2, 3], 'array');
    const result = await judge.evaluate({
      testCase,
      output: [1, 2, 3],
      expected: 'array',
      rubric: JSON.stringify({
        type: 'array',
        items: { type: 'number' },
      }),
    });

    expect(result.score).toBe(1);
  });

  it('should validate enum schema', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase('red', 'enum');
    const result = await judge.evaluate({
      testCase,
      output: 'red',
      expected: 'enum',
      rubric: JSON.stringify({
        type: 'enum',
        values: ['red', 'green', 'blue'],
      }),
    });

    expect(result.score).toBe(1);
  });

  it('should reject invalid enum value', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase('yellow', 'enum');
    const result = await judge.evaluate({
      testCase,
      output: 'yellow',
      expected: 'enum',
      rubric: JSON.stringify({
        type: 'enum',
        values: ['red', 'green', 'blue'],
      }),
    });

    expect(result.score).toBe(0);
  });

  it('should handle invalid JSON in rubric', async () => {
    const judge = new SchemaMatchJudge();
    const testCase = createTestCase('hello', 'string');
    const result = await judge.evaluate({
      testCase,
      output: 'hello',
      expected: 'string',
      rubric: 'not valid json',
    });

    expect(result.score).toBe(0);
    expect(result.reason).toContain('Error');
  });
});