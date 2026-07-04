// Tests for applyExecutorOverride — session-level TASK_EXECUTOR env var
// promotes llm_call tasks to cli_spawn with the configured hint, unless the
// task already carries an explicit executor_hint (decomposer-assigned wins).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyExecutorOverride } from '../../src/brain/executor/internal-utils.js';
import type { Task } from '../../src/types/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'tk_test',
    workflow_id: 'wf_test',
    name: 'test task',
    kind: 'llm_call',
    depends_on: [],
    executor_hint: null,
    model: null,
    tool_name: null,
    acceptance_criteria: null,
    input_json: null,
    output_text: null,
    status: 'pending',
    created_at: 0,
    started_at: null,
    finished_at: null,
    attempts: 0,
    error_text: null,
    hitl_required: false,
    hitl_gate_id: null,
    input_tokens: null,
    output_tokens: null,
    model_used: null,
    refine_feedback: null,
    execution_mode: 'single',
  };
  return { ...base, ...overrides };
}

let snapshot: string | undefined;
beforeEach(() => {
  snapshot = process.env['TASK_EXECUTOR'];
  delete process.env['TASK_EXECUTOR'];
});
afterEach(() => {
  if (snapshot === undefined) delete process.env['TASK_EXECUTOR'];
  else process.env['TASK_EXECUTOR'] = snapshot;
});

describe('applyExecutorOverride', () => {
  it('no env var set → returns task unchanged', () => {
    const task = makeTask({ kind: 'llm_call' });
    const out = applyExecutorOverride(task);
    expect(out).toBe(task); // same reference
  });

  it('TASK_EXECUTOR=cli:cursor promotes llm_call → cli_spawn', () => {
    process.env['TASK_EXECUTOR'] = 'cli:cursor';
    const task = makeTask({ kind: 'llm_call' });
    const out = applyExecutorOverride(task);
    expect(out.kind).toBe('cli_spawn');
    expect(out.executor_hint).toBe('cli:cursor');
  });

  it('TASK_EXECUTOR=cli:opencode preserves all other task fields', () => {
    process.env['TASK_EXECUTOR'] = 'cli:opencode';
    const task = makeTask({
      kind: 'llm_call',
      name: 'summarize report',
      acceptance_criteria: 'bulleted summary',
      model: 'cc/claude-sonnet-4-6',
    });
    const out = applyExecutorOverride(task);
    expect(out.name).toBe('summarize report');
    expect(out.acceptance_criteria).toBe('bulleted summary');
    expect(out.model).toBe('cc/claude-sonnet-4-6'); // OpenCode will use -m
  });

  it('explicit task.executor_hint wins over env override', () => {
    process.env['TASK_EXECUTOR'] = 'cli:cursor';
    const task = makeTask({ kind: 'llm_call', executor_hint: 'cli:claude-code' });
    const out = applyExecutorOverride(task);
    expect(out).toBe(task); // hint preserved, no promotion
  });

  it('tool_call tasks are never promoted (deterministic path)', () => {
    process.env['TASK_EXECUTOR'] = 'cli:cursor';
    const task = makeTask({ kind: 'tool_call' });
    const out = applyExecutorOverride(task);
    expect(out).toBe(task);
  });

  it('pal_call tasks are never promoted', () => {
    process.env['TASK_EXECUTOR'] = 'cli:cursor';
    const task = makeTask({ kind: 'pal_call' });
    const out = applyExecutorOverride(task);
    expect(out).toBe(task);
  });

  it('existing cli_spawn tasks are left alone (hint preserved)', () => {
    process.env['TASK_EXECUTOR'] = 'cli:cursor';
    const task = makeTask({ kind: 'cli_spawn', executor_hint: 'cli:claude-code' });
    const out = applyExecutorOverride(task);
    expect(out).toBe(task);
  });

  it('non-cli: env value (e.g. model id) is ignored to avoid miscategorization', () => {
    process.env['TASK_EXECUTOR'] = 'cc/claude-sonnet-4-6';
    const task = makeTask({ kind: 'llm_call' });
    const out = applyExecutorOverride(task);
    expect(out).toBe(task); // never promoted; model ids are not CLI overrides
  });
});
