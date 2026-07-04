import { describe, expect, it } from 'vitest';
import {
  buildDashboardPlannerObjective,
  planDashboardDag,
} from '../../src/mcp/dashboard-plan-ops.js';

const oneTaskDag = {
  tasks: [
    {
      id: 't0',
      name: 'Draft execution plan',
      kind: 'llm_call',
      depends_on: [],
      acceptance_criteria: 'Valid JSON object with plan and status fields',
      model: 'cc/claude-sonnet-4-6',
    },
  ],
};

describe('dashboard plan operations', () => {
  it('plans a DAG from a dashboard objective without executing it', async () => {
    const calls: unknown[] = [];
    const result = await planDashboardDag(
      {
        workspace: 'internal',
        objective: 'Create a QA report for the dashboard',
      },
      async (raw) => {
        calls.push(raw);
        return JSON.stringify({
          status: 'plan_ready',
          workspace: 'internal',
          objective: raw.objective,
          task_count: 1,
          pattern_used: null,
          skill_applied: null,
          execution_mode_source: 'default',
          plan: oneTaskDag.tasks,
          dag_json: JSON.stringify(oneTaskDag),
        });
      },
    );

    expect(calls).toEqual([
      {
        workspace: 'internal',
        objective: 'Create a QA report for the dashboard',
        workflow_mode: 'standard',
      },
    ]);
    expect(result).toMatchObject({
      status: 'plan_ready',
      workspace: 'internal',
      objective: 'Create a QA report for the dashboard',
      task_count: 1,
      dag: oneTaskDag,
    });
  });

  it('builds a revision prompt with the current DAG and operator feedback', () => {
    const objective = buildDashboardPlannerObjective({
      objective: 'Build a data pipeline',
      feedback: 'Use a cheaper model for the extraction task',
      current_dag: oneTaskDag,
    });

    expect(objective).toContain('Original objective:');
    expect(objective).toContain('Build a data pipeline');
    expect(objective).toContain('Current DAG JSON:');
    expect(objective).toContain('"id": "t0"');
    expect(objective).toContain('Requested changes:');
    expect(objective).toContain('Use a cheaper model');
    expect(objective).toContain('Return an updated Omniforge DAG');
  });

  it('rejects planner output that does not contain an executable DAG', async () => {
    await expect(planDashboardDag(
      { workspace: 'internal', objective: 'Broken plan' },
      async () => JSON.stringify({
        status: 'plan_ready',
        workspace: 'internal',
        objective: 'Broken plan',
        dag_json: JSON.stringify({
          tasks: [
            {
              id: 't1',
              name: 'Broken',
              kind: 'llm_call',
              depends_on: ['missing'],
            },
          ],
        }),
      }),
    )).rejects.toThrow(/graph-integrity/);
  });
});
