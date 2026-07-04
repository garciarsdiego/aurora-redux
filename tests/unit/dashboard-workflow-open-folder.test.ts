import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../src/db/client.js';
import { resolveDashboardWorkflowFolderTarget } from '../../src/mcp/routes/dashboard-workflow-ops.js';

describe('dashboard workflow open-folder target', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('opens the git worktree when cli_spawn artifacts were written there', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omniforge-open-folder-'));
    const workspaceBase = join(tempDir, 'workspaces');
    const worktreeBase = join(tempDir, 'data', 'worktrees');
    const worktreeRoot = join(worktreeBase, 'internal', 'wf_artifact');
    mkdirSync(join(worktreeRoot, 'src'), { recursive: true });
    mkdirSync(join(workspaceBase, 'internal', 'runs', 'wf_artifact'), { recursive: true });
    writeFileSync(join(worktreeRoot, 'src', 'index.html'), '<!doctype html>');

    const db = initDb(':memory:');
    try {
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
         VALUES ('wf_artifact', 'internal', 'Build app', 'completed', 1, 2, 1, 'test')`,
      ).run();
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'wf_artifact',
        null,
        'task_worktree_reused',
        JSON.stringify({
          worktree_root: worktreeRoot,
          output_dir: join(workspaceBase, 'internal', 'runs', 'wf_artifact'),
        }),
        3,
      );

      const target = resolveDashboardWorkflowFolderTarget(
        db,
        { id: 'wf_artifact', workspace: 'internal' },
        { workspaceBase, worktreeBase },
      );

      expect(target.source).toBe('git_worktree');
      expect(target.path).toBe(worktreeRoot);
      expect(target.reason).toContain('source artifacts');
    } finally {
      db.close();
    }
  });

  it('falls back to the run output directory when no non-empty worktree is recorded', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'omniforge-open-folder-'));
    const workspaceBase = join(tempDir, 'workspaces');
    const worktreeBase = join(tempDir, 'data', 'worktrees');
    const outputDir = join(workspaceBase, 'internal', 'runs', 'wf_output');
    mkdirSync(outputDir, { recursive: true });

    const db = initDb(':memory:');
    try {
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
         VALUES ('wf_output', 'internal', 'Write report', 'completed', 1, 2, 1, 'test')`,
      ).run();

      const target = resolveDashboardWorkflowFolderTarget(
        db,
        { id: 'wf_output', workspace: 'internal' },
        { workspaceBase, worktreeBase },
      );

      expect(target.source).toBe('output_dir');
      expect(target.path).toBe(outputDir);
    } finally {
      db.close();
    }
  });
});
