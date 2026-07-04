import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import { createContextChannel, createContextMessage, ensureTaskContextThread } from '../../src/context/store.js';
import { recordArchitectureContract } from '../../src/workflow-modes/existing-code-feature.js';
import { getArchitectureContractTool } from '../../src/mcp/tools/get_architecture_contract.js';
import { postTaskHandoffTool } from '../../src/mcp/tools/post_task_handoff.js';
import { readTaskThreadTool } from '../../src/mcp/tools/read_task_thread.js';
import { inspectWorkflowDiffTool } from '../../src/mcp/tools/inspect_workflow_diff.js';
import { createFixTaskTool } from '../../src/mcp/tools/create_fix_task.js';
import { requestArchitectureReviewTool } from '../../src/mcp/tools/request_architecture_review.js';
import { requestProductReviewTool } from '../../src/mcp/tools/request_product_review.js';
import type { Task, Workflow } from '../../src/types/index.js';

const tempDirs: string[] = [];

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'Modify an existing app',
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
    metadata: JSON.stringify({ workflow_mode: 'existing_code_feature' }),
  };
}

function makeTask(workflowId: string, root: string, id = newTaskId()): Task {
  const now = Date.now();
  return {
    id,
    workflow_id: workflowId,
    name: 'Implement existing code feature',
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: { worktree_root: root } }),
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: 'cli:codex',
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: now,
    acceptance_criteria: 'Feature integrates into src/App.tsx',
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
    workspace: 'internal',
  };
}

describe('MCP context collaboration tools', () => {
  afterEach(() => {
    delete process.env.DB_PATH;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads architecture contracts, task threads, handoffs, diffs, and dry-run fix tasks', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-mcp-context-tools-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'omniforge.db');
    const projectRoot = join(tempDir, 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'src', 'sidecar.tsx'),
      [
        'import { createRoot } from "react-dom/client";',
        'const sidecar = document.createElement("div");',
        'sidecar.dataset.omniforgeSidecar = "task-modules";',
        'document.body.appendChild(sidecar);',
        'createRoot(sidecar).render(null);',
      ].join('\n'),
    );
    process.env.DB_PATH = dbPath;

    const db = initDb(dbPath);
    const workflow = makeWorkflow('wf_mcp_context');
    const task = makeTask(workflow.id, projectRoot, 'tk_mcp_context');
    insertWorkflow(db, workflow);
    insertTask(db, task);
    const channel = createContextChannel(db, {
      workspace: workflow.workspace,
      kind: 'run',
      name: `run:${workflow.id}`,
      title: 'MCP context workflow',
      runId: workflow.id,
    });
    const thread = ensureTaskContextThread(db, {
      channelId: channel.id,
      runId: workflow.id,
      taskId: task.id,
      title: task.name,
    });
    createContextMessage(db, {
      threadId: thread.id,
      senderType: 'system',
      senderId: 'test',
      kind: 'event',
      body: 'hello thread sk-test-secret-value',
    });
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot,
        appType: 'react',
        existingStateStores: ['src/state/task-store.ts'],
        existingUiSurfaces: ['src/App.tsx'],
        allowedFiles: ['src/**'],
        forbiddenPatterns: ['Mounting a separate DOM island outside the existing app shell.'],
        requiredIntegrationPoints: ['src/App.tsx'],
        testSelectors: ['#root'],
      },
    });
    db.close();

    const contract = JSON.parse(await getArchitectureContractTool({ workflow_id: workflow.id })) as Record<string, unknown>;
    expect(JSON.stringify(contract)).toContain('src/App.tsx');

    const threadResult = JSON.parse(await readTaskThreadTool({ workflow_id: workflow.id, task_id: task.id })) as Record<string, unknown>;
    expect(JSON.stringify(threadResult)).not.toContain('sk-test-secret-value');
    expect(JSON.stringify(threadResult)).toContain('***');

    const handoff = JSON.parse(await postTaskHandoffTool({
      workflow_id: workflow.id,
      task_id: task.id,
      body: 'Implemented in src/App.tsx with token sk-handoff-secret-value',
      files_touched: ['src/App.tsx'],
    })) as Record<string, unknown>;
    expect(JSON.stringify(handoff)).not.toContain('sk-handoff-secret-value');

    const diff = JSON.parse(await inspectWorkflowDiffTool({ workflow_id: workflow.id })) as { roots: Array<{ root: string; exists: boolean }> };
    expect(diff.roots.some((root) => root.exists && root.root.includes('project'))).toBe(true);

    const dryRun = JSON.parse(await createFixTaskTool({
      workflow_id: workflow.id,
      title: 'Fix integration',
      objective: 'Move feature into existing app shell',
      acceptance_criteria: 'src/App.tsx imports the feature and build exits 0',
    })) as Record<string, unknown>;
    expect(dryRun.created).toBe(false);
    expect(dryRun.reason).toBe('dry-run');

    const architectureReview = JSON.parse(await requestArchitectureReviewTool({
      workflow_id: workflow.id,
    })) as Record<string, unknown>;
    expect(architectureReview.outcome).toBe('blocked');
    expect(JSON.stringify(architectureReview)).toContain('sidecar_dom_island');

    const productReview = JSON.parse(await requestProductReviewTool({
      workflow_id: workflow.id,
    })) as Record<string, unknown>;
    expect(productReview.outcome).toBe('blocked');
    expect(JSON.stringify(productReview)).toContain('sidecar_dom_island');
    expect(JSON.stringify(productReview)).not.toContain('sk-test-secret-value');
  });
});
