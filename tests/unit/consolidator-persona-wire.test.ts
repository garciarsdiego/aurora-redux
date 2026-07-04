import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Task, Workflow } from '../../src/types/index.js';

const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));

vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

const { consolidateWorkflow } = await import('../../src/brain/consolidator.js');

function baseWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf_1',
    workspace: 'internal',
    objective: 'Build two independent widgets and summarize the result.',
    pattern_id: null,
    status: 'completed',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    metadata: null,
    ...overrides,
  };
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    workflow_id: 'wf_1',
    name: 'Widget task',
    kind: 'llm_call',
    input_json: null,
    output_json: JSON.stringify({ result: 'ok' }),
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
    acceptance_criteria: 'Output contains ok.',
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
    workspace: process.cwd(),
    ...overrides,
  };
}

describe('consolidator persona wire', () => {
  const previousFlag = process.env.OMNIFORGE_USE_PERSONAS;

  beforeEach(() => {
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = previousFlag;
  });

  it('keeps the legacy consolidator path when OMNIFORGE_USE_PERSONAS is false', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    omnirouteMock.callOmniroute.mockResolvedValue('legacy consolidated output');

    const result = await consolidateWorkflow(baseWorkflow(), [
      baseTask({ id: 'task_1', name: 'A', output_json: 'A output' }),
      baseTask({ id: 'task_2', name: 'B', output_json: 'B output' }),
    ]);

    expect(result).toBe('legacy consolidated output');
    expect(omnirouteMock.callOmniroute).toHaveBeenCalledTimes(1);
    expect(omnirouteMock.callOmnirouteWithUsage).not.toHaveBeenCalled();
  });

  it('uses CONSOLIDATOR_PERSONA and maps summary to the legacy string contract', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'true';
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: JSON.stringify({
        summary: 'persona consolidated output',
        conflicts: [],
        gaps: [],
        files_written_total: [],
      }),
      model_used: 'cc/claude-sonnet-4-6',
    });

    const result = await consolidateWorkflow(baseWorkflow(), [
      baseTask({ id: 'task_1', name: 'A', output_json: '{"a":true}' }),
      baseTask({ id: 'task_2', name: 'B', output_json: '{"b":true}' }),
    ]);

    expect(result).toBe('persona consolidated output');
    expect(omnirouteMock.callOmnirouteWithUsage).toHaveBeenCalledTimes(1);
    expect(omnirouteMock.callOmniroute).not.toHaveBeenCalled();
  });

  it('builds ConsolidatorInput from task outputs and renders parallel_outputs context', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'true';
    let capturedSystemPrompt = '';
    omnirouteMock.callOmnirouteWithUsage.mockImplementation(async (args: { systemPrompt: string }) => {
      capturedSystemPrompt = args.systemPrompt;
      return {
        content: JSON.stringify({
          summary: 'with workspace',
          conflicts: [],
          gaps: ['task_2 failed'],
          files_written_total: [],
        }),
        model_used: 'cc/claude-sonnet-4-6',
      };
    });

    const result = await consolidateWorkflow(
      baseWorkflow({ id: 'wf_with_workspace', objective: 'Merge branch outputs.' }),
      [
        baseTask({
          id: 'task_1',
          name: 'Succeeded branch',
          output_json: JSON.stringify({ files_written: ['src/a.ts'], result_text: 'done' }),
          status: 'completed',
        }),
        baseTask({
          id: 'task_2',
          name: 'Failed branch',
          output_json: 'boom',
          status: 'failed',
        }),
      ],
      { workspaceDir: 'C:/repo' },
    );

    expect(result).toBe('with workspace');
    expect(capturedSystemPrompt).toContain('# Workflow objective');
    expect(capturedSystemPrompt).toContain('Merge branch outputs.');
    expect(capturedSystemPrompt).toContain('"task_id": "task_1"');
    expect(capturedSystemPrompt).toContain('"status": "success"');
    expect(capturedSystemPrompt).toContain('"files_written": [');
    expect(capturedSystemPrompt).toContain('"src/a.ts"');
    expect(capturedSystemPrompt).toContain('"task_id": "task_2"');
    expect(capturedSystemPrompt).toContain('"status": "failed"');
  });

  it('passes workspace_dir into the persona postHook and falls back on validation failure', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'true';
    const workspaceDir = mkdtempSync(path.join(tmpdir(), 'omniforge-consolidator-wire-'));
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: JSON.stringify({
        summary: 'persona claimed fake file',
        conflicts: [],
        gaps: [],
        files_written_total: ['src/Fake.ts'],
      }),
      model_used: 'cc/claude-sonnet-4-6',
    });
    omnirouteMock.callOmniroute.mockResolvedValue('legacy fallback output');

    const result = await consolidateWorkflow(
      baseWorkflow(),
      [
        baseTask({ id: 'task_1', name: 'A', output_json: 'A output' }),
        baseTask({ id: 'task_2', name: 'B', output_json: 'B output' }),
      ],
      { workspaceDir },
    );

    expect(result).toBe('legacy fallback output');
    expect(omnirouteMock.callOmnirouteWithUsage).toHaveBeenCalledTimes(1);
    expect(omnirouteMock.callOmniroute).toHaveBeenCalledTimes(1);
  });
});
