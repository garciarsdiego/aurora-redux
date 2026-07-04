// M1 Wave 2 (2026-05-12, gap B4): Setup → Tools toggle wiring.
//
// Before this change, flipping a tool toggle in the Setup → Tools pane only
// updated React local state — the daemon kept all registered tools reachable
// forever. With migration 047 (`workspace_tool_overrides`) plus the
// `POST /api/dashboard/setup/tools/:toolId/toggle` endpoint, disabling a tool
// for a workspace persists and the executor's tool-call entry point throws
// `ToolDisabledError` + emits `tool_disabled_by_policy`.
//
// This integration test exercises the full chain:
//   1. Insert a disabled row directly into workspace_tool_overrides (mirrors
//      what the endpoint does — keeps the test independent of the HTTP layer).
//   2. Invoke the bash tool via `resolveTool('bash')`.
//   3. Assert `ToolDisabledError` is thrown.
//   4. Assert a `tool_disabled_by_policy` event landed under the workflow_id.
//   5. Re-enable the tool → expect the tool to execute again.
//
// Default-ON path is also covered (empty overrides → tool executes).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from '../../src/db/client.js';
import { resolveTool, type ToolContext } from '../../src/v2/tools/registry.js';
// Side-effect import — registers the seven core tools and the guard wrapper.
import '../../src/v2/tools/core/index.js';
import { ToolDisabledError } from '../../src/v2/tools/core/index.js';

const WORKSPACE = 'tool_disable_ws';
const WORKFLOW_ID = 'wf_tool_disable_test';

let tmpDir: string;
let dbPath: string;
let originalDbPath: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-tool-disable-'));
  dbPath = join(tmpDir, 'omniforge.db');
  originalDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;

  // Bootstrap migrations + sentinel workflow row so insertEvent can write
  // `tool_disabled_by_policy` events under our test workflow.
  const db = initDb(dbPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, workspace, objective, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(WORKFLOW_ID, WORKSPACE, 'tool-disable test', 'executing', now);
  } finally {
    db.close();
  }
});

afterAll(() => {
  if (originalDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = originalDbPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts with a clean override table so leakage from a prior
  // case doesn't change the default-ON contract.
  const db = initDb(dbPath);
  try {
    db.prepare(`DELETE FROM workspace_tool_overrides WHERE workspace = ?`).run(WORKSPACE);
    db.prepare(`DELETE FROM events WHERE workflow_id = ?`).run(WORKFLOW_ID);
  } finally {
    db.close();
  }
});

function makeCtx(): ToolContext {
  return {
    workspace: WORKSPACE,
    workflowId: WORKFLOW_ID,
    workspaceRoot: tmpDir,
  };
}

function setOverride(toolId: string, enabled: boolean): void {
  const db = initDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO workspace_tool_overrides (workspace, tool_id, enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace, tool_id) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    ).run(WORKSPACE, toolId, enabled ? 1 : 0, Date.now());
  } finally {
    db.close();
  }
}

function getDisabledEvents(): Array<{ tool_id: string; workspace: string }> {
  const db = initDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT payload_json FROM events
          WHERE workflow_id = ? AND type = 'tool_disabled_by_policy'
          ORDER BY id`,
      )
      .all(WORKFLOW_ID) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as { tool_id: string; workspace: string });
  } finally {
    db.close();
  }
}

describe('migration 047 applies cleanly', () => {
  it('creates workspace_tool_overrides table with composite PK + workspace index', () => {
    const db = initDb(dbPath);
    try {
      const tbl = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_tool_overrides'`,
        )
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('workspace_tool_overrides');

      const idx = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_tool_overrides_workspace'`,
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe('idx_workspace_tool_overrides_workspace');

      const cols = db
        .prepare(`PRAGMA table_info('workspace_tool_overrides')`)
        .all() as Array<{ name: string; notnull: number; pk: number }>;
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect(byName.get('workspace')?.notnull).toBe(1);
      expect(byName.get('tool_id')?.notnull).toBe(1);
      expect(byName.get('enabled')?.notnull).toBe(1);
      expect(byName.get('updated_at')?.notnull).toBe(1);
      expect(byName.get('workspace')?.pk).toBe(1);
      expect(byName.get('tool_id')?.pk).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('Setup → Tools toggle enforcement', () => {
  it('default-ON: empty workspace_tool_overrides → tool executes normally', async () => {
    // No row inserted; calculator should run.
    const tool = resolveTool('calculator');
    const result = await tool.execute({ expression: '1+1' }, makeCtx());
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).result).toBe(2);
    expect(getDisabledEvents()).toHaveLength(0);
  });

  it('disabling a tool throws ToolDisabledError and emits tool_disabled_by_policy', async () => {
    setOverride('calculator', false);

    const tool = resolveTool('calculator');
    let thrown: unknown;
    try {
      await tool.execute({ expression: '1+1' }, makeCtx());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ToolDisabledError);
    expect((thrown as ToolDisabledError).toolId).toBe('calculator');
    expect((thrown as ToolDisabledError).workspace).toBe(WORKSPACE);

    const events = getDisabledEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ tool_id: 'calculator', workspace: WORKSPACE });
  });

  it('re-enabling a previously-disabled tool resumes execution', async () => {
    setOverride('calculator', false);
    setOverride('calculator', true);

    const tool = resolveTool('calculator');
    const result = await tool.execute({ expression: '3*4' }, makeCtx());
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).result).toBe(12);
    expect(getDisabledEvents()).toHaveLength(0);
  });

  it('disabling one tool does NOT affect other tools in the same workspace', async () => {
    setOverride('calculator', false);

    // calculator should refuse, current-time should run.
    const calcTool = resolveTool('calculator');
    await expect(calcTool.execute({ expression: '2+2' }, makeCtx()))
      .rejects.toBeInstanceOf(ToolDisabledError);

    const timeTool = resolveTool('current-time');
    const result = await timeTool.execute({ timezone: 'UTC' }, makeCtx());
    expect(result.success).toBe(true);

    const events = getDisabledEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.tool_id).toBe('calculator');
  });

  it('disabling a tool in one workspace does NOT affect another workspace', async () => {
    // Disable calculator for OUR test workspace.
    setOverride('calculator', false);

    // Build a context for a DIFFERENT workspace — calculator should still run.
    const otherCtx: ToolContext = {
      workspace: 'some_other_workspace',
      workflowId: WORKFLOW_ID, // event will land under the test workflow if any
      workspaceRoot: tmpDir,
    };

    const tool = resolveTool('calculator');
    const result = await tool.execute({ expression: '5+5' }, otherCtx);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).result).toBe(10);
  });
});
