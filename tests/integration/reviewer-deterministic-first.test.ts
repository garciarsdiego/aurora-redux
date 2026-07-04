/**
 * OPP-R1 — deterministic-first reviewer integration tests.
 *
 * Verifies that `deterministicReview()` short-circuits the reviewer pipeline
 * for parseable structural assertions, and that `reviewTask()` escalates to
 * the LLM judge only when assertions are inconclusive.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  deterministicReview,
  reviewTask,
} from '../../src/reviewer/reviewer.js';
import type { Task } from '../../src/types/index.js';

function makeTask(criteria: string | null): Task {
  return {
    id: 't1',
    workflow_id: 'wf1',
    name: 'test',
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'completed',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: criteria,
    refine_count: 0,
    max_refine: 3,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

describe('OPP-R1 deterministic-first reviewer', () => {
  it('hard-passes on string equality (Output equals "X")', () => {
    const task = makeTask('Output equals "Final value: 36845"');
    const result = deterministicReview(task, 'Final value: 36845');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(true);
    expect(result?.score).toBe(1);
  });

  it('hard-fails on list-length mismatch (Output has exactly N lines)', () => {
    const task = makeTask('Output has exactly 3 lines');
    const result = deterministicReview(task, 'line1\nline2\nline3\nline4');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(false);
    expect(result?.feedback).toMatch(/4 lines, expected 3/);
  });

  it('hard-passes on regex match (Output matches regex /.../)', () => {
    const task = makeTask('Output matches regex /^v\\d+\\.\\d+\\.\\d+$/');
    const result = deterministicReview(task, 'v1.2.3');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(true);
  });

  it('hard-passes on JSON shape (Output is valid JSON with keys [a, b])', () => {
    const task = makeTask('Output is valid JSON with keys [name, age]');
    const result = deterministicReview(task, '{"name": "Example", "age": 36}');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(true);
  });

  it('hard-fails when JSON missing a required key', () => {
    const task = makeTask('Output is valid JSON with keys [name, age]');
    const result = deterministicReview(task, '{"name": "Example"}');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(false);
    expect(result?.feedback).toMatch(/missing keys.*age/);
  });

  it('hard-passes on length-between assertion', () => {
    const task = makeTask('Output length between 5 and 20 chars');
    const result = deterministicReview(task, 'hello world');
    expect(result?.passed).toBe(true);
  });

  it('hard-passes on contains assertion', () => {
    const task = makeTask('Output contains "success"');
    const result = deterministicReview(task, 'pipeline ran with success status');
    expect(result?.passed).toBe(true);
  });

  // Opt 4 — unquoted "contains [exactly] the line: <text>" phrasing must be
  // recognized and treated as a SUBSTRING check (not whole-string-equals).
  it('hard-passes on unquoted "contains the line: <text>" (substring, with colon in text)', () => {
    const task = makeTask('Output contains the line: Final value: 36845');
    // Output contains the phrase as a substring (surrounded by other text).
    const result = deterministicReview(task, 'computed result\nFinal value: 36845\ndone');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(true);
    expect(result?.score).toBe(1);
  });

  it('hard-passes on unquoted "contains exactly the line: <text>" against exact output', () => {
    const task = makeTask('Output contains exactly the line: Final value: 36845');
    const result = deterministicReview(task, 'Final value: 36845');
    expect(result?.passed).toBe(true);
  });

  it('hard-fails when the unquoted "contains the line:" substring is absent', () => {
    const task = makeTask('Output contains the line: Final value: 36845');
    const result = deterministicReview(task, 'Final value: 99999');
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(false);
    expect(result?.feedback).toMatch(/missing required substring/i);
  });

  it('returns null (inconclusive) when criteria has no parseable assertions — escalates to LLM', async () => {
    const task = makeTask('The summary should be useful and well-organized');
    const result = deterministicReview(task, 'some output');
    expect(result).toBeNull();
  });

  it('reviewTask short-circuits when deterministic checks pass (no LLM call)', async () => {
    // If the deterministic check passes, reviewTask should never reach the
    // omniroute/persona path. We assert by passing a task that would otherwise
    // require an LLM and observing the synchronous-style fast return.
    const task = makeTask('Output equals "ok"');
    const result = await reviewTask(task, 'ok');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.feedback).toMatch(/Deterministic checks passed/);
  });
});
