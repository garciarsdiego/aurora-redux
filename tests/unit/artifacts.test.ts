import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { initDb } from '../../src/db/client.js';
import {
  saveArtifact,
  loadArtifactContent,
  loadArtifactsForTask,
  loadArtifactsForWorkflow,
} from '../../src/artifacts/store.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import {
  newWorkflowId,
  newTaskId,
  insertWorkflow,
  insertTask,
} from '../../src/db/persist.js';
import type { Dag, Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id: string, workspace: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective: 'artifact test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    metadata: null,
  };
}

function makeTask(id: string, wfId: string): Task {
  return {
    id,
    workflow_id: wfId,
    name: 'Test Task',
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
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
  };
}

describe('artifact store — inline vs file', () => {
  it('small content (<16KB) stored inline, hash correct, loadArtifactsForTask returns it', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, makeWorkflow(wfId, 'test'));
    insertTask(db, { ...makeTask(taskId, wfId) });

    const content = 'Hello, artifact world!';
    const art = await saveArtifact(db, {
      workflow_id: wfId,
      task_id: taskId,
      workspace: 'test',
      content,
      basePath: tmpdir(),
    });

    expect(art.content_inline).toBe(content);
    expect(art.content_path).toBeNull();
    expect(art.size_bytes).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(art.hash_sha256).toHaveLength(64);
    expect(art.kind).toBe('text');

    const loaded = await loadArtifactContent(art);
    expect(loaded).toBe(content);

    const artifacts = await loadArtifactsForTask(db, taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe(art.id);

    const wfArtifacts = await loadArtifactsForWorkflow(db, wfId);
    expect(wfArtifacts).toHaveLength(1);

    db.close();
  });

  it('json content inferred as kind=json', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();
    insertWorkflow(db, makeWorkflow(wfId, 'test'));
    insertTask(db, { ...makeTask(taskId, wfId) });

    const art = await saveArtifact(db, {
      workflow_id: wfId,
      task_id: taskId,
      workspace: 'test',
      content: '{"key": "value"}',
      basePath: tmpdir(),
    });

    expect(art.kind).toBe('json');
    db.close();
  });

  it('content >=16KB stored on disk, content_inline is null, content readable', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();
    insertWorkflow(db, makeWorkflow(wfId, 'test'));
    insertTask(db, { ...makeTask(taskId, wfId) });

    const tempDir = join(tmpdir(), `omniforge-test-${Date.now()}`);

    const bigContent = 'x'.repeat(16 * 1024); // exactly 16KB
    const art = await saveArtifact(db, {
      workflow_id: wfId,
      task_id: taskId,
      workspace: 'test',
      content: bigContent,
      basePath: tempDir,
    });

    expect(art.content_inline).toBeNull();
    expect(art.content_path).not.toBeNull();
    expect(art.content_path).toContain(taskId);
    expect(art.size_bytes).toBe(16 * 1024);

    const loaded = await loadArtifactContent(art);
    expect(loaded).toBe(bigContent);

    await rm(tempDir, { recursive: true, force: true });
    db.close();
  });
});

describe('artifact store — executor integration', () => {
  it('task A output saved as artifact; task B receives it in input_json as upstream_artifacts', async () => {
    const db = initDb(':memory:');
    const capturedInputs: Record<string, string | null> = {};

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: ['a'] },
      ],
    };

    const mockExecute = async (task: Task): Promise<string> => {
      capturedInputs[task.name] = task.input_json;
      return `output of ${task.name}`;
    };

    const wf = await executeWorkflow(db, dag, 'test', 'artifact injection', {
      executeTaskFn: mockExecute,
      consolidateFn: async () => 'done',
    });

    expect(wf.status).toBe('completed');

    // Task A has no upstream — input_json should NOT have upstream_artifacts
    const aInput = capturedInputs['Task A'];
    if (aInput) {
      const parsed = JSON.parse(aInput) as Record<string, unknown>;
      expect(parsed['upstream_artifacts']).toBeUndefined();
    }

    // Task B depends on A — input_json must contain upstream_artifacts with A's output
    const bInput = capturedInputs['Task B'];
    expect(bInput).not.toBeNull();
    const bParsed = JSON.parse(bInput!) as Record<string, unknown>;
    expect(typeof bParsed['upstream_artifacts']).toBe('string');
    expect(bParsed['upstream_artifacts'] as string).toContain('output of Task A');

    // Artifact should be in the DB
    const [aTask] = db
      .prepare(`SELECT id FROM tasks WHERE workflow_id = ? AND name = 'Task A'`)
      .all(wf.id) as { id: string }[];
    const artifacts = await loadArtifactsForTask(db, aTask.id);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts[0].content_inline).toContain('output of Task A');

    db.close();
  });

  it('fan-in: task C sees artifacts from both A and B', async () => {
    const db = initDb(':memory:');
    let cUpstream: string | undefined;

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: [] },
        { id: 'c', name: 'Task C', kind: 'llm_call', depends_on: ['a', 'b'] },
      ],
    };

    const mockExecute = async (task: Task): Promise<string> => {
      if (task.name === 'Task C' && task.input_json) {
        const ctx = JSON.parse(task.input_json) as Record<string, unknown>;
        cUpstream = ctx['upstream_artifacts'] as string | undefined;
      }
      return `output of ${task.name}`;
    };

    await executeWorkflow(db, dag, 'test', 'fan-in artifact test', {
      executeTaskFn: mockExecute,
      consolidateFn: async () => 'done',
    });

    expect(cUpstream).toBeDefined();
    expect(cUpstream).toContain('output of Task A');
    expect(cUpstream).toContain('output of Task B');

    db.close();
  });
});
