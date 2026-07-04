import { describe, it, expect, vi, afterEach } from 'vitest';
import { DagSchema } from '../../src/types/schemas.js';
import { runOmniRouteTask } from '../../src/executors/omniroute.js';
import type { Task } from '../../src/types/index.js';

const { callMock } = vi.hoisted(() => ({
  callMock: vi.fn().mockResolvedValue({
    content: 'routed output',
    model_used: 'cc/claude-haiku-4-5-20251001',
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
}));

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('legacy output'),
  callOmnirouteWithUsage: callMock,
}));

describe('model routing', () => {
  afterEach(() => {
    callMock.mockClear();
  });

  it('DagSchema preserves model_route metadata for executor materialisation', () => {
    const parsed = DagSchema.parse({
      tasks: [{
        id: 't1',
        name: 'fast task',
        kind: 'llm_call',
        depends_on: [],
        model_route: { use_case: 'Tarefa Rápida', strategy: 'cost' },
      }],
    });

    expect(parsed.tasks[0]!.model_route).toEqual({
      use_case: 'Tarefa Rápida',
      strategy: 'cost',
    });
  });

  it('runOmniRouteTask uses model_route when task.model is absent', async () => {
    const task: Task = {
      id: 'tk_route',
      workflow_id: 'wf_route',
      name: 'Fast routed task',
      kind: 'llm_call',
      input_json: JSON.stringify({
        objective: 'pick a cheap fast model',
        model_route: { use_case: 'Tarefa Rápida', strategy: 'cost' },
      }),
      output_json: null,
      status: 'pending',
      depends_on: [],
      executor_hint: null,
      timeout_seconds: 60,
      max_retries: 0,
      retry_count: 0,
      retry_policy: 'none',
      started_at: null,
      completed_at: null,
      created_at: Date.now(),
      acceptance_criteria: null,
      refine_count: 0,
      max_refine: 0,
      refine_feedback: null,
      model: null,
      hitl: false,
    };

    const output = await runOmniRouteTask(task);

    expect(output).toBe('routed output');
    expect(callMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'cc/claude-haiku-4-5-20251001',
    }));
  });

  it('explicit task.model overrides model_route', async () => {
    const task: Task = {
      id: 'tk_route_override',
      workflow_id: 'wf_route',
      name: 'Override routed task',
      kind: 'llm_call',
      input_json: JSON.stringify({
        model_route: { use_case: 'Tarefa Rápida', strategy: 'cost' },
      }),
      output_json: null,
      status: 'pending',
      depends_on: [],
      executor_hint: null,
      timeout_seconds: 60,
      max_retries: 0,
      retry_count: 0,
      retry_policy: 'none',
      started_at: null,
      completed_at: null,
      created_at: Date.now(),
      acceptance_criteria: null,
      refine_count: 0,
      max_refine: 0,
      refine_feedback: null,
      model: 'cc/claude-opus-4-7',
      hitl: false,
    };

    await runOmniRouteTask(task);

    expect(callMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'cc/claude-opus-4-7',
    }));
  });

  it('prompts execution-plan tasks to emit the concrete plan instead of critiquing it', async () => {
    const task: Task = {
      id: 'tk_plan_review',
      workflow_id: 'wf_route',
      name: 'Review execution plan',
      kind: 'llm_call',
      input_json: JSON.stringify({
        objective: 'add task create/delete/subtask features',
        execution_plan: {
          current_task_id: 't0',
          tasks: [
            { id: 't0', name: 'Review execution plan', kind: 'llm_call', depends_on: [] },
            { id: 't1', name: 'Explore existing codebase', kind: 'cli_spawn', depends_on: ['t0'] },
            { id: 't2', name: 'Implement task creation UI', kind: 'cli_spawn', depends_on: ['t1'] },
          ],
        },
      }),
      output_json: null,
      status: 'pending',
      depends_on: [],
      executor_hint: null,
      timeout_seconds: 60,
      max_retries: 0,
      retry_count: 0,
      retry_policy: 'none',
      started_at: null,
      completed_at: null,
      created_at: Date.now(),
      acceptance_criteria: 'Plan lists all subsequent tasks with their kinds and deliverables',
      refine_count: 0,
      max_refine: 0,
      refine_feedback: null,
      model: 'cx/gpt-5.4',
      hitl: false,
    };

    await runOmniRouteTask(task);

    const [{ userPrompt }] = callMock.mock.calls.at(-1) as [{ userPrompt: string }];
    expect(userPrompt).toContain('EXECUTION PLAN TO EMIT');
    expect(userPrompt).toContain('Do not critique, grade, approve, reject, or recommend revisions');
    expect(userPrompt).toContain('| id | name | kind | depends_on | deliverable |');
    expect(userPrompt).not.toContain('EXECUTION PLAN TO REVIEW');
  });
});
