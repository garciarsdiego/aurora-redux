/**
 * Wave 3 — M1-W3-B / Agent test-automator.
 *
 * Smoke tests for MCP tools that lacked direct unit coverage at the MCP
 * wrapper layer. Vol.2 audit found 31/53 MCP tools without a dedicated
 * tests/unit/*.test.ts file. Wave 1.5 + Wave 2 closed some via downstream
 * coverage; this file closes the rest at the wrapper layer.
 *
 * Approach: Zod schema smoke (invalid → throws, valid → expected shape)
 * + TOOLS-registry wiring smoke. Behaviour tests live in the downstream
 * module tests (vault-store, persona-version-replay, meta-orchestrator,
 * opencode-sync, etc.). This file guards the MCP boundary contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';

import { TOOLS } from '../../src/mcp/server.js';
import {
  VaultWriteSchema,
  VaultReadSchema,
  VaultListSchema,
  VaultDeleteSchema,
  VaultMergeSchema,
  omniforge_vault_write,
  omniforge_vault_read,
  omniforge_vault_list,
} from '../../src/mcp/tools/vault.js';
import { inputSchema as replayInputSchema } from '../../src/mcp/tools/replay_persona_version.js';
import { inputSchema as metaInputSchema } from '../../src/mcp/tools/run_meta_workflow.js';
import { OpencodeSyncModelsSchema } from '../../src/mcp/tools/opencode_sync_models.js';
import { BuilderChatSchema } from '../../src/mcp/tools/builder_chat.js';
import { TailCliSchema } from '../../src/mcp/tools/tail_cli.js';
import {
  ADVISOR_NAMES,
  isAdvisorToolName,
  buildAdvisorToolDefinitions,
  runAdvisorTool,
} from '../../src/mcp/tools/advisor_tools.js';
import { dashboardPatternsRouter } from '../../src/mcp/routes/dashboard-patterns.js';

// ────────────────────────────────────────────────────────────────────────────
// Vault MCP tool wrappers
// ────────────────────────────────────────────────────────────────────────────

describe('vault MCP tool schemas', () => {
  it('VaultWriteSchema rejects missing workspace', () => {
    expect(() => VaultWriteSchema.parse({ path: 'a.txt', content: 'x' })).toThrow(ZodError);
  });

  it('VaultWriteSchema rejects empty path', () => {
    expect(() => VaultWriteSchema.parse({ workspace: 'ws', path: '', content: 'x' })).toThrow(ZodError);
  });

  it('VaultWriteSchema accepts a complete payload', () => {
    expect(VaultWriteSchema.parse({ workspace: 'ws', path: 'a.txt', content: 'hi' })).toMatchObject({
      workspace: 'ws',
      path: 'a.txt',
      content: 'hi',
    });
  });

  it('VaultReadSchema accepts a workspace + path payload', () => {
    expect(VaultReadSchema.parse({ workspace: 'ws', path: 'a.txt' })).toMatchObject({
      workspace: 'ws',
      path: 'a.txt',
    });
  });

  it('VaultListSchema allows omitting glob and rejects empty glob', () => {
    expect(VaultListSchema.parse({ workspace: 'ws' }).workspace).toBe('ws');
    expect(() => VaultListSchema.parse({ workspace: 'ws', glob: '' })).toThrow(ZodError);
  });

  it('VaultDeleteSchema rejects missing path', () => {
    expect(() => VaultDeleteSchema.parse({ workspace: 'ws' })).toThrow(ZodError);
  });

  it('VaultMergeSchema requires partial object', () => {
    expect(() => VaultMergeSchema.parse({ workspace: 'ws', path: 'a.json' })).toThrow(ZodError);
    expect(VaultMergeSchema.parse({ workspace: 'ws', path: 'a.json', partial: {} }).partial).toEqual({});
  });
});

describe('vault MCP tool handlers (real Vault on tmpdir)', () => {
  let tmp: string | undefined;
  let origCwd: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'omniforge-vault-mcp-'));
    origCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    if (origCwd) process.chdir(origCwd);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('write returns ok:true with a parseable VaultEntry', async () => {
    const raw = await omniforge_vault_write({ workspace: 'wsx', path: 'note.txt', content: 'hi' });
    const parsed = JSON.parse(raw) as { ok: boolean; entry: { path: string; sizeBytes: number } };
    expect(parsed.ok).toBe(true);
    expect(parsed.entry.path).toBe('note.txt');
    expect(parsed.entry.sizeBytes).toBeGreaterThan(0);
  });

  it('read returns the previously-written content', async () => {
    await omniforge_vault_write({ workspace: 'wsy', path: 'a.txt', content: 'value' });
    const raw = await omniforge_vault_read({ workspace: 'wsy', path: 'a.txt' });
    expect(JSON.parse(raw)).toMatchObject({ workspace: 'wsy', path: 'a.txt', content: 'value' });
  });

  it('list returns the entry after write', async () => {
    await omniforge_vault_write({ workspace: 'wsz', path: 'l.txt', content: 'data' });
    const raw = await omniforge_vault_list({ workspace: 'wsz' });
    const parsed = JSON.parse(raw) as { entries: Array<{ path: string }> };
    expect(parsed.entries.some((e) => e.path === 'l.txt')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// replay_persona_version
// ────────────────────────────────────────────────────────────────────────────

describe('replay_persona_version schema', () => {
  it('rejects empty persona_id', () => {
    expect(() => replayInputSchema.parse({ persona_id: '', version: '1', input: {} })).toThrow(ZodError);
  });

  it('rejects empty version', () => {
    expect(() => replayInputSchema.parse({ persona_id: 'decomposer', version: '', input: {} })).toThrow(ZodError);
  });

  it('rejects invalid workspace name (path separator)', () => {
    expect(() =>
      replayInputSchema.parse({
        persona_id: 'decomposer',
        version: '1.0.0',
        input: {},
        workspace: '../escape',
      }),
    ).toThrow(ZodError);
  });

  it('applies default workspace=global', () => {
    const parsed = replayInputSchema.parse({ persona_id: 'decomposer', version: '1.0.0', input: { x: 1 } });
    expect(parsed.workspace).toBe('global');
  });

  it('accepts arbitrary unknown input shape', () => {
    expect(() =>
      replayInputSchema.parse({
        persona_id: 'reviewer',
        version: '2.5.1',
        input: [1, 2, 3],
        workspace: 'internal',
      }),
    ).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// run_meta_workflow
// ────────────────────────────────────────────────────────────────────────────

describe('run_meta_workflow schema', () => {
  it('rejects empty specs array', () => {
    expect(() => metaInputSchema.parse({ specs: [] })).toThrow(ZodError);
  });

  it('rejects spec with invalid workspace', () => {
    expect(() =>
      metaInputSchema.parse({ specs: [{ id: 's1', workspace: 'has/slash', objective: 'do' }] }),
    ).toThrow(ZodError);
  });

  it('rejects spec with empty objective', () => {
    expect(() =>
      metaInputSchema.parse({ specs: [{ id: 's1', workspace: 'internal', objective: '' }] }),
    ).toThrow(ZodError);
  });

  it('accepts minimal valid input and applies default maxConcurrency=3', () => {
    const parsed = metaInputSchema.parse({
      specs: [{ id: 's1', workspace: 'internal', objective: 'echo' }],
    });
    expect(parsed.maxConcurrency).toBe(3);
    expect(parsed.specs).toHaveLength(1);
  });

  it('rejects maxConcurrency below 1', () => {
    expect(() =>
      metaInputSchema.parse({
        specs: [{ id: 's', workspace: 'internal', objective: 'o' }],
        maxConcurrency: 0,
      }),
    ).toThrow(ZodError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// opencode_sync_models
// ────────────────────────────────────────────────────────────────────────────

describe('opencode_sync_models schema', () => {
  it('accepts empty input', () => {
    expect(OpencodeSyncModelsSchema.parse({})).toEqual({});
  });

  it('parses bin_path + timeout_ms', () => {
    const parsed = OpencodeSyncModelsSchema.parse({ bin_path: '/usr/bin/opencode', timeout_ms: 5000 });
    expect(parsed.bin_path).toBe('/usr/bin/opencode');
    expect(parsed.timeout_ms).toBe(5000);
  });

  it('rejects empty bin_path, out-of-range timeout, and negative timeout', () => {
    expect(() => OpencodeSyncModelsSchema.parse({ bin_path: '' })).toThrow(ZodError);
    expect(() => OpencodeSyncModelsSchema.parse({ timeout_ms: 60_001 })).toThrow(ZodError);
    expect(() => OpencodeSyncModelsSchema.parse({ timeout_ms: -1 })).toThrow(ZodError);
  });
});

describe('opencode_sync_models handler (binary absent)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/v2/models/opencode-sync.js');
    vi.resetModules();
  });

  it('returns JSON envelope with bin/count/sample when opencode is missing', async () => {
    vi.doMock('../../src/v2/models/opencode-sync.js', () => ({
      refreshOpencodeModels: vi.fn(async () => []),
      getOpencodeModelsFetchedAt: vi.fn(() => null),
    }));
    const { opencodeSyncModelsTool } = await import('../../src/mcp/tools/opencode_sync_models.js');
    const raw = await opencodeSyncModelsTool({});
    const parsed = JSON.parse(raw) as {
      bin: string;
      count: number;
      sample: unknown[];
      fetched_at: string | null;
      error_hint?: string;
    };
    expect(parsed.count).toBe(0);
    expect(parsed.sample).toEqual([]);
    expect(typeof parsed.bin).toBe('string');
    expect(parsed.error_hint).toMatch(/opencode binary unavailable/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// builder_chat
// ────────────────────────────────────────────────────────────────────────────

describe('builder_chat schema', () => {
  it('rejects missing fields', () => {
    expect(() => BuilderChatSchema.parse({})).toThrow(ZodError);
  });

  it('rejects any empty required field', () => {
    expect(() => BuilderChatSchema.parse({ workspace: '', session_id: 's', message: 'hi' })).toThrow(ZodError);
    expect(() => BuilderChatSchema.parse({ workspace: 'ws', session_id: '', message: 'hi' })).toThrow(ZodError);
    expect(() => BuilderChatSchema.parse({ workspace: 'ws', session_id: 's', message: '' })).toThrow(ZodError);
  });

  it('parses a complete payload', () => {
    expect(BuilderChatSchema.parse({ workspace: 'ws', session_id: 'sess_001', message: 'help' })).toMatchObject({
      workspace: 'ws',
      session_id: 'sess_001',
      message: 'help',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// advisor_tools registration
// ────────────────────────────────────────────────────────────────────────────

describe('advisor_tools registration smoke', () => {
  it('ADVISOR_NAMES exposes 17 entries', () => {
    expect(ADVISOR_NAMES).toHaveLength(17);
  });

  it('isAdvisorToolName accepts every advisor and rejects unknowns', () => {
    for (const name of ADVISOR_NAMES) {
      expect(isAdvisorToolName(`omniforge_${name}`)).toBe(true);
    }
    expect(isAdvisorToolName('omniforge_unknown')).toBe(false);
    expect(isAdvisorToolName('not_a_tool')).toBe(false);
    expect(isAdvisorToolName('omniforge_')).toBe(false);
  });

  it('buildAdvisorToolDefinitions returns 17 entries with mode property', () => {
    const defs = buildAdvisorToolDefinitions();
    expect(defs).toHaveLength(17);
    for (const def of defs) {
      expect(def.name.startsWith('omniforge_')).toBe(true);
      expect(def.inputSchema.properties.mode.enum).toEqual(['stepwise', 'oneshot', 'auto']);
      expect(def.inputSchema.properties.mode.default).toBe('auto');
      expect(def.inputSchema.additionalProperties).toBe(true);
    }
  });

  it('runAdvisorTool throws for non-advisor tool names', async () => {
    await expect(runAdvisorTool('not_a_tool', {})).rejects.toThrow(/Not an advisor tool/);
  });

  it('all advisor names are wired in TOOLS', () => {
    const toolNames = new Set(TOOLS.map((t) => t.name));
    for (const advisor of ADVISOR_NAMES) {
      expect(toolNames.has(`omniforge_${advisor}`)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// tail_cli
// ────────────────────────────────────────────────────────────────────────────

describe('tail_cli schema', () => {
  it('rejects empty workflow_id or task_id', () => {
    expect(() => TailCliSchema.parse({ workflow_id: '', task_id: 't1' })).toThrow(ZodError);
    expect(() => TailCliSchema.parse({ workflow_id: 'wf', task_id: '' })).toThrow(ZodError);
  });

  it('applies default limit=50 and accepts since_event_id', () => {
    expect(TailCliSchema.parse({ workflow_id: 'wf', task_id: 't1' }).limit).toBe(50);
    expect(
      TailCliSchema.parse({ workflow_id: 'wf', task_id: 't1', since_event_id: 100 }).since_event_id,
    ).toBe(100);
  });
});

describe('tail_cli handler (task missing)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/db/client.js');
    vi.doUnmock('../../src/utils/config.js');
    vi.doUnmock('../../src/db/persist.js');
    vi.resetModules();
  });

  it('returns empty event list when task not found in workflow', async () => {
    vi.doMock('../../src/db/client.js', () => ({ initDb: vi.fn(() => ({ close: vi.fn() })) }));
    vi.doMock('../../src/utils/config.js', () => ({ getDbPath: vi.fn(() => ':memory:') }));
    vi.doMock('../../src/db/persist.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/db/persist.js')>();
      return { ...actual, loadWorkflowTasks: vi.fn(() => []) };
    });
    const { tailCliTool } = await import('../../src/mcp/tools/tail_cli.js');
    const result = await tailCliTool({ workflow_id: 'wf', task_id: 'missing_task' });
    expect(result).toEqual({ events: [], session_path: null, cli_id: 'unknown', total_events: 0 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Patterns HTTP router (4 routes — list/save/export/import from Wave 2)
// ────────────────────────────────────────────────────────────────────────────

describe('dashboard-patterns HTTP router smoke', () => {
  it('exports a Router function', () => {
    expect(typeof dashboardPatternsRouter).toBe('function');
  });

  it('returns false for unrelated paths', async () => {
    const fakeReq = { method: 'GET' } as never;
    const fakeRes = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as never;
    const url = new URL('http://x/api/unrelated/path');
    const handled = await dashboardPatternsRouter(fakeReq, url, fakeRes);
    expect(handled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Top-level registry smoke — confirm all target tools are wired
// ────────────────────────────────────────────────────────────────────────────

describe('MCP TOOLS registry — Wave 3 target tools', () => {
  const TARGET_TOOLS = [
    'omniforge_task_await',
    'omniforge_task_cancel',
    'omniforge_vault_write',
    'omniforge_vault_read',
    'omniforge_vault_list',
    'omniforge_vault_delete',
    'omniforge_vault_merge',
    'omniforge_replay_persona_version',
    'omniforge_run_meta_workflow',
    'omniforge_request_product_review',
    'omniforge_request_architecture_review',
    'omniforge_get_architecture_contract',
    'omniforge_inspect_workflow_diff',
    'omniforge_post_task_handoff',
    'omniforge_read_task_thread',
    'omniforge_create_fix_task',
    'omniforge_opencode_sync_models',
    'omniforge_get_context_bundle',
    'omniforge_builder_chat',
    'omniforge_tail_cli',
  ];

  for (const toolName of TARGET_TOOLS) {
    it(`registers ${toolName}`, () => {
      expect(TOOLS.map((t) => t.name)).toContain(toolName);
    });
  }

  it('every target tool has a non-empty description and object schema', () => {
    const targetSet = new Set(TARGET_TOOLS);
    for (const tool of TOOLS) {
      if (!targetSet.has(tool.name)) continue;
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});
