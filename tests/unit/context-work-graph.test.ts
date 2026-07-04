import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { ensureWorkflowWorkGraph, safeEnsureWorkflowWorkGraph } from '../../src/context/work-graph.js';
import { listWorkItemTree } from '../../src/context/store.js';

describe('context work graph', () => {
  it('creates one run batch and one child work item per workflow task', () => {
    const db = initDb(':memory:');

    const graph = ensureWorkflowWorkGraph(db, {
      workspace: 'internal',
      runId: 'wf_graph',
      objective: 'Build the app',
      tasks: [
        { id: 'tk_a', name: 'Scaffold', kind: 'cli_spawn' },
        { id: 'tk_b', name: 'Review', kind: 'llm_call', dependsOn: ['tk_a'] },
      ],
    });
    const again = ensureWorkflowWorkGraph(db, {
      workspace: 'internal',
      runId: 'wf_graph',
      objective: 'Build the app again',
      tasks: [
        { id: 'tk_a', name: 'Scaffold changed', kind: 'cli_spawn' },
        { id: 'tk_b', name: 'Review changed', kind: 'llm_call', dependsOn: ['tk_a'] },
      ],
    });

    expect(again.root.id).toBe(graph.root.id);
    expect(again.tasks.map((task) => task.id)).toEqual(graph.tasks.map((task) => task.id));
    const items = listWorkItemTree(db, graph.root.id);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'batch', run_id: 'wf_graph', parent_id: null });
    expect(items.slice(1).map((item) => item.task_id)).toEqual(['tk_a', 'tk_b']);
    expect(items[2]?.metadata_json).toContain('tk_a');

    db.close();
  });

  it('safe helper does not throw when work item table is unavailable', () => {
    const db = initDb(':memory:');
    db.exec('DROP TABLE work_items');

    expect(() => safeEnsureWorkflowWorkGraph(db, {
      workspace: 'internal',
      runId: 'wf_safe',
      objective: 'safe',
      tasks: [{ id: 'tk_safe', name: 'Safe', kind: 'llm_call' }],
    })).not.toThrow();

    db.close();
  });
});
