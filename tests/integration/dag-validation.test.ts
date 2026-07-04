import { describe, it, expect } from 'vitest';
import { validateDag } from '../../src/brain/dag-validator.js';

describe('DAG Validation Integration', () => {
  it('accepts valid DAG with no cycles', () => {
    const validDag = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: [] },
        { id: 'task2', name: 'Task 2', kind: 'llm_call', depends_on: ['task1'] },
        { id: 'task3', name: 'Task 3', kind: 'cli_spawn', depends_on: ['task1'] },
      ],
    };

    const result = validateDag(validDag);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects DAG with cycles', () => {
    const cyclicDag = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: ['task2'] },
        { id: 'task2', name: 'Task 2', kind: 'llm_call', depends_on: ['task3'] },
        { id: 'task3', name: 'Task 3', kind: 'llm_call', depends_on: ['task1'] },
      ],
    };

    const result = validateDag(cyclicDag);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: any) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects DAG with missing task dependencies', () => {
    const dagWithMissingDep = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: ['nonexistent'] },
      ],
    };

    const result = validateDag(dagWithMissingDep);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects DAG with duplicate task IDs', () => {
    const dagWithDuplicates = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: [] },
        { id: 'task1', name: 'Task 1 Duplicate', kind: 'cli_spawn', depends_on: [] },
      ],
    };

    const result = validateDag(dagWithDuplicates);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects DAG with invalid task kind', () => {
    const dagWithInvalidKind = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'invalid_kind', depends_on: [] },
      ],
    };

    const result = validateDag(dagWithInvalidKind);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts complex valid DAG with multiple dependencies', () => {
    const complexDag = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: [] },
        { id: 'task2', name: 'Task 2', kind: 'llm_call', depends_on: ['task1'] },
        { id: 'task3', name: 'Task 3', kind: 'cli_spawn', depends_on: ['task1'] },
        {
          id: 'task4',
          name: 'Task 4',
          kind: 'tool_call',
          depends_on: ['task2', 'task3'],
          tool_name: 'file-write',
          args: { path: 'out/result.json', content: '{"status":"ok"}' },
        },
      ],
    };

    const result = validateDag(complexDag);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects DAG with self-dependency', () => {
    const dagWithSelfDep = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: ['task1'] },
      ],
    };

    const result = validateDag(dagWithSelfDep);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates task metadata structure', () => {
    const dagWithMetadata = {
      tasks: [
        {
          id: 'task1',
          name: 'Task 1',
          kind: 'llm_call',
          depends_on: [],
          model: 'cx/gpt-5.4',
          timeout_seconds: 300,
          max_retries: 3,
        },
      ],
    };

    const result = validateDag(dagWithMetadata);
    expect(result.valid).toBe(true);
  });

  it('provides helpful error messages', () => {
    const invalidDag = {
      tasks: [
        { id: 'task1', name: 'Task 1', kind: 'llm_call', depends_on: ['task2'] },
        { id: 'task2', name: 'Task 2', kind: 'llm_call', depends_on: ['task1'] },
      ],
    };

    const result = validateDag(invalidDag);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toBeDefined();
    expect(result.errors[0].task_id).toBeDefined();
  });
});