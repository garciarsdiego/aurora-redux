/**
 * Aurora-parity Wave 1 (WS2) — deterministic precommit secret-scan gate.
 * scanTextForSecrets is mocked (so this test never embeds a real secret literal
 * that the repo's own pre-commit scanner would flag); a real temp git worktree
 * exercises the diff-listing + event path. Real in-memory DB for events/FK.
 */

import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/v2/security/secret-scan.js', () => ({ scanTextForSecrets: vi.fn(() => []) }));

import { initDb } from '../../src/db/client.js';
import { insertWorkflowWithTasks } from '../../src/db/persist.js';
import { runPrecommitGate } from '../../src/brain/validation/precommit-gate.js';
import { scanTextForSecrets } from '../../src/v2/security/secret-scan.js';
import type { Task, Workflow } from '../../src/types/index.js';

function git(cwd: string, ...args: string[]): void { execFileSync('git', args, { cwd, stdio: 'ignore' }); }

const tmpDirs: string[] = [];
function worktreeWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-precommit-'));
  tmpDirs.push(dir);
  git(dir, 'init'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'seed.txt'), 'seed'); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'seed');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'config.ts'), 'export const x = 1;\n'); // uncommitted change
  return dir;
}

let db: Database.Database;
beforeEach(() => {
  vi.clearAllMocks();
  db = initDb(':memory:');
  const wf = { id: 'wf-1', workspace: 'internal', objective: 'o', pattern_id: null, status: 'executing', started_at: Date.now(), completed_at: null, created_at: Date.now(), created_by: 't', estimated_cost_usd: null, actual_cost_usd: null, max_total_cost_usd: null, max_duration_seconds: null, metadata: null } as Workflow;
  // Seed the task row too so events' FK (events.task_id -> tasks.id) is satisfied.
  insertWorkflowWithTasks(db, wf, [cliTask(null)]);
});
afterEach(() => {
  db.close();
  while (tmpDirs.length) { try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function cliTask(worktreeRoot: string | null): Task {
  const input: Record<string, unknown> = { workspace: 'internal' };
  if (worktreeRoot) input['execution_context'] = { worktree_root: worktreeRoot };
  return { id: 't1', workflow_id: 'wf-1', name: 'code', kind: 'cli_spawn', input_json: JSON.stringify(input), output_json: null, status: 'completed', depends_on: [], executor_hint: null, timeout_seconds: 300, max_retries: 3, retry_count: 0, retry_policy: 'exponential', started_at: null, completed_at: null, created_at: Date.now(), acceptance_criteria: null } as Task;
}

function events(type: string): Array<Record<string, unknown>> {
  return (db.prepare('SELECT payload_json FROM events WHERE type = ?').all(type) as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json));
}

describe('runPrecommitGate', () => {
  it('emits a finding + needs_fixes scan when a changed file contains a secret', () => {
    vi.mocked(scanTextForSecrets).mockReturnValue([{ filePath: 'src/config.ts', line: 1, column: 1, ruleId: 'omniroute_api_key', redacted: 'sk-***' }]);
    const r = runPrecommitGate(db, cliTask(worktreeWithChange()), 'wf-1');
    expect(r.ran).toBe(true);
    expect(r.secretFindings).toBe(1);
    const findings = events('task_precommit_finding');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe('src/config.ts');
    expect(events('task_precommit_scan')[0]!.needs_fixes).toBe(true);
  });

  it('emits a clean scan (no finding) when the diff has no secrets', () => {
    vi.mocked(scanTextForSecrets).mockReturnValue([]);
    const r = runPrecommitGate(db, cliTask(worktreeWithChange()), 'wf-1');
    expect(r.ran).toBe(true);
    expect(r.secretFindings).toBe(0);
    expect(events('task_precommit_finding')).toHaveLength(0);
    expect(events('task_precommit_scan')[0]!.needs_fixes).toBe(false);
  });

  it('skips non-cli_spawn tasks (ran=false, scanner never called)', () => {
    const t = { ...cliTask(null), kind: 'llm_call' } as Task;
    const r = runPrecommitGate(db, t, 'wf-1');
    expect(r.ran).toBe(false);
    expect(scanTextForSecrets).not.toHaveBeenCalled();
  });

  it('skips when no worktree can be derived (ran=false)', () => {
    const r = runPrecommitGate(db, cliTask(null), 'wf-1');
    expect(r.ran).toBe(false);
  });
});
