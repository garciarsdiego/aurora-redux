import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertEvent, insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import { saveContextPacket, saveTaskHandoff } from '../../src/context/store.js';
import { buildTaskQualityEvidenceBundle } from '../../src/quality/evidence.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'build a playable web app without leaking sk-secret123456789',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(workflowId: string, worktreeRoot: string, outputDir: string, id = newTaskId()): Task {
  const now = Date.now();
  return {
    id,
    workflow_id: workflowId,
    name: 'Implement controls',
    kind: 'cli_spawn',
    input_json: JSON.stringify({
      execution_context: {
        worktree_root: worktreeRoot,
        output_dir: outputDir,
        source_cwd: worktreeRoot,
      },
    }),
    output_json: `Created src/App.tsx in ${worktreeRoot} using OPENAI_API_KEY=sk-secret123456789`,
    status: 'completed',
    depends_on: [],
    executor_hint: 'cli:codex',
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: now,
    completed_at: now,
    created_at: now,
    acceptance_criteria: 'src/App.tsx exists with healthy content',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

describe('task quality evidence bundle', () => {
  it('collects task output, filesystem, events, context, and redacts secrets', () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-'));
    try {
      const worktreeRoot = join(tempRoot, 'worktree');
      const outputDir = join(tempRoot, 'output');
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(join(worktreeRoot, '.keep'), 'x', { flag: 'w' });
      writeFileSync(
        join(worktreeRoot, 'src-App-placeholder.txt'),
        'not used',
        { flag: 'w' },
      );
      const appPath = join(worktreeRoot, 'src');
      mkdirSync(appPath, { recursive: true });
      writeFileSync(
        join(appPath, 'App.tsx'),
        ['export function App() {', '  return <main>Tetris</main>;', '}', 'export default App;', '// ok'].join('\n'),
      );

      const db = initDb(':memory:');
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, worktreeRoot, outputDir);
      insertWorkflow(db, workflow);
      insertTask(db, task);
      insertEvent(db, {
        workflow_id: workflow.id,
        task_id: task.id,
        type: 'task_completed',
        payload: { token: 'mcp-secret123456' },
      });
      saveContextPacket(db, {
        runId: workflow.id,
        taskId: task.id,
        attempt: 1,
        packet: { Authorization: 'Bearer abc.def.ghi' },
        renderedPrompt: 'prompt',
        includedHandoffs: [],
        excludedItems: [],
        tokenEstimate: 1,
        truncated: false,
      });
      saveTaskHandoff(db, {
        runId: workflow.id,
        taskId: task.id,
        attempt: 1,
        kind: 'summary',
        title: 'Done',
        body: 'Implemented app with sk-secret123456789',
        artifacts: ['src/App.tsx'],
        filesTouched: ['src/App.tsx'],
        decisions: [],
        safeContext: {},
        tokenEstimate: 1,
        truncated: false,
      });

      const bundle = buildTaskQualityEvidenceBundle(db, workflow.id, task.id);
      const json = JSON.stringify(bundle);
      expect(bundle.executionContext.workspaceDir).toBe(worktreeRoot);
      expect(bundle.filesystem.summary.files_verified).toContain('src/App.tsx');
      expect(bundle.eventsTail.some((event) => event.type === 'task_completed')).toBe(true);
      expect(bundle.contextPacketsTail).toHaveLength(1);
      expect(bundle.handoffsTail).toHaveLength(1);
      expect(bundle.output.preview).not.toContain('sk-secret');
      expect(json).not.toContain('mcp-secret');
      expect(json).not.toContain('abc.def.ghi');
      expect(json).not.toContain('sk-secret');
      db.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses output_dir when the worker explicitly wrote there and worktree is empty', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-output-'));
    try {
      const outputDir = join(tempRoot, 'output');
      const worktreeRoot = join(tempRoot, 'worktree');
      mkdirSync(join(outputDir, 'src'), { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(
        join(outputDir, 'src', 'App.tsx'),
        ['export function App() {', '  return <main>Output dir</main>;', '}', 'export default App;', '// ok'].join('\n'),
      );

      const db = initDb(':memory:');
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, worktreeRoot, outputDir);
      task.output_json = `Created src/App.tsx in OUTPUT_DIR ${outputDir}`;
      insertWorkflow(db, workflow);
      insertTask(db, task);

      const bundle = buildTaskQualityEvidenceBundle(db, workflow.id, task.id);
      expect(bundle.executionContext.workspaceDir).toBe(outputDir);
      expect(bundle.filesystem.summary.files_verified).toContain('src/App.tsx');
      db.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
