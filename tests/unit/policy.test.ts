import { describe, it, expect } from 'vitest';
import { matchesAutoApprovePolicy } from '../../src/hitl/policy.js';
import type { Task } from '../../src/types/index.js';
import type { HitlConfig } from '../../src/hitl/config.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_1', workflow_id: 'wf_1', name: 'test task', kind: 'llm_call',
    input_json: null, output_json: null, status: 'pending',
    depends_on: [], executor_hint: null, timeout_seconds: 60,
    max_retries: 0, retry_count: 0, retry_policy: 'none',
    started_at: null, completed_at: null, created_at: Date.now(),
    acceptance_criteria: null, refine_count: 0, max_refine: 0,
    refine_feedback: null, model: null, hitl: true,
    ...overrides,
  };
}

function makeConfig(auto_approve_if: HitlConfig['auto_approve_if']): HitlConfig {
  return { channel: 'terminal', slack_listener_port: 3742, auto_approve_if };
}

describe('matchesAutoApprovePolicy', () => {
  it('returns false when config is null', () => {
    expect(matchesAutoApprovePolicy(makeTask(), null, 'ws')).toBe(false);
  });

  it('returns false when auto_approve_if is absent', () => {
    expect(matchesAutoApprovePolicy(makeTask(), makeConfig(undefined), 'ws')).toBe(false);
  });

  it('kind string match → true', () => {
    const task = makeTask({ kind: 'llm_call' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ kind: 'llm_call' }), 'ws')).toBe(true);
  });

  it('kind string mismatch → false', () => {
    const task = makeTask({ kind: 'cli_spawn' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ kind: 'llm_call' }), 'ws')).toBe(false);
  });

  it('kind array OR: task matches one entry → true', () => {
    const task = makeTask({ kind: 'pal_call' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ kind: ['llm_call', 'pal_call'] }), 'ws')).toBe(true);
  });

  it('kind array OR: task not in list → false', () => {
    const task = makeTask({ kind: 'cli_spawn' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ kind: ['llm_call', 'pal_call'] }), 'ws')).toBe(false);
  });

  it('model string match → true', () => {
    const task = makeTask({ model: 'cc/claude-opus-4-7' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ model: 'cc/claude-opus-4-7' }), 'ws')).toBe(true);
  });

  it('model required but task.model is null → false', () => {
    const task = makeTask({ model: null });
    expect(matchesAutoApprovePolicy(task, makeConfig({ model: 'cc/claude-opus-4-7' }), 'ws')).toBe(false);
  });

  it('AND: kind + model both match → true', () => {
    const task = makeTask({ kind: 'llm_call', model: 'cc/claude-opus-4-7' });
    const config = makeConfig({ kind: 'llm_call', model: 'cc/claude-opus-4-7' });
    expect(matchesAutoApprovePolicy(task, config, 'ws')).toBe(true);
  });

  it('AND: kind matches but model mismatches → false', () => {
    const task = makeTask({ kind: 'llm_call', model: 'other-model' });
    const config = makeConfig({ kind: 'llm_call', model: 'cc/claude-opus-4-7' });
    expect(matchesAutoApprovePolicy(task, config, 'ws')).toBe(false);
  });

  it('workspace string match → true', () => {
    const task = makeTask({ kind: 'llm_call' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ workspace: 'internal' }), 'internal')).toBe(true);
  });

  it('workspace string mismatch → false', () => {
    const task = makeTask({ kind: 'llm_call' });
    expect(matchesAutoApprovePolicy(task, makeConfig({ workspace: 'internal' }), 'globex')).toBe(false);
  });

  it('empty policy object approves everything (no constraints)', () => {
    const task = makeTask({ kind: 'cli_spawn', model: null });
    expect(matchesAutoApprovePolicy(task, makeConfig({}), 'any-workspace')).toBe(true);
  });
});
