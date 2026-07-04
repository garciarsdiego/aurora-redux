import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';

// Mock omniroute-call (transitive import via executor)
vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('llm-output'),
}));

// Mock artifact store
vi.mock('../../src/artifacts/store.js', () => ({
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  loadArtifactsForTask: vi.fn().mockResolvedValue([]),
  loadArtifactContent: vi.fn().mockResolvedValue(''),
  loadArtifactsForWorkflow: vi.fn().mockResolvedValue([]),
}));

import { registerTool, resolveTool, listTools, type ToolContext } from '../../src/v2/tools/registry.js';
// Importing core tools registers them as side-effect
import '../../src/v2/tools/core/index.js';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import {
  createVersionedDefinition,
  pinVersionedDefinition,
} from '../../src/v2/governance/versioned-registry.js';
import type { Dag, Task } from '../../src/types/index.js';

// Builds a per-test ToolContext rooted in an OS temp directory so file-rw
// tools stay inside their sandbox during integration tests.
function makeCtx(workspaceRoot: string): ToolContext {
  return {
    workspace: '__test__',
    workflowId: 'wf_test_0001',
    workspaceRoot,
  };
}

// ---------------------------------------------------------------------------
// ToolRegistry — unit tests
// ---------------------------------------------------------------------------

describe('ToolRegistry', () => {
  it('registerTool + resolveTool returns the registered tool', () => {
    const { z } = require('zod') as typeof import('zod');
    registerTool({
      name: '__test_tool__',
      description: 'test',
      argsSchema: z.object({ value: z.string() }),
      async execute(args) { return { success: true, output: args.value }; },
    });
    const tool = resolveTool('__test_tool__');
    expect(tool.name).toBe('__test_tool__');
  });

  it('resolveTool throws for unknown tool name', () => {
    expect(() => resolveTool('no-such-tool-xyz')).toThrow("Tool not found in registry: 'no-such-tool-xyz'");
  });

  it('listTools returns registered tool names including core tools', () => {
    const tools = listTools();
    expect(tools).toContain('bash');
    expect(tools).toContain('file-write');
    expect(tools).toContain('file-read');
    expect(tools).toContain('http-request');
    expect(tools).toContain('current-time');
    expect(tools).toContain('calculator');
    expect(tools).toContain('knowledge-search');
  });
});

// ---------------------------------------------------------------------------
// Core tools — direct execution tests
// ---------------------------------------------------------------------------

describe('core tool: bash', () => {
  it('allowlisted command (node --version) returns stdout with success=true', async () => {
    // Use --version which is portable across Win cmd / sh quoting and avoids
    // the cmd-vs-shell single-quote ambiguity. Validates allowlist + sandbox.
    const tool = resolveTool('bash');
    const ctx = makeCtx(tmpdir());
    const result = await tool.execute({ command: 'node --version' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^v\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  it('command outside allowlist returns success=false (sandboxed)', async () => {
    const tool = resolveTool('bash');
    const ctx = makeCtx(tmpdir());
    const result = await tool.execute({ command: 'sudo echo hello' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not in allowlist');
  });

  it('non-existent allowlisted command returns success=false', async () => {
    const tool = resolveTool('bash');
    const ctx = makeCtx(tmpdir());
    // 'node' IS in allowlist but flag forces an error inside node itself
    const result = await tool.execute({ command: 'node --does-not-exist-xyz' }, ctx);
    expect(result.success).toBe(false);
  });

  it('rejects shell metacharacters even when the first token is allowlisted', async () => {
    const tool = resolveTool('bash');
    const ctx = makeCtx(tmpdir());
    const result = await tool.execute({ command: 'node --version && node --version' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/metacharacter|shell/i);
  });
});

describe('core tool: file-write + file-read', () => {
  let sandbox: string;
  let ctx: ToolContext;
  const RELATIVE = `tool-rw-${Date.now()}.txt`;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'omniforge-sandbox-'));
    ctx = makeCtx(sandbox);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('file-write creates a file with the given content', async () => {
    const tool = resolveTool('file-write');
    const result = await tool.execute({ path: RELATIVE, content: 'hello-from-tool' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello-from-tool'.length.toString());
  });

  it('file-read reads back what file-write wrote', async () => {
    const writeTool = resolveTool('file-write');
    const readTool = resolveTool('file-read');
    await writeTool.execute({ path: RELATIVE, content: 'roundtrip-content' }, ctx);
    const result = await readTool.execute({ path: RELATIVE }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('roundtrip-content');
  });

  it('file-read on non-existent path returns success=false', async () => {
    const tool = resolveTool('file-read');
    const result = await tool.execute({ path: 'no-such-file.txt' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('file-write + file-read roundtrip with multi-line content', async () => {
    const writeTool = resolveTool('file-write');
    const readTool = resolveTool('file-read');
    const content = 'line1\nline2\nline3';
    await writeTool.execute({ path: RELATIVE, content }, ctx);
    const result = await readTool.execute({ path: RELATIVE }, ctx);
    expect(result.output).toBe(content);
  });

  it('file-write rejects path that escapes the workspace sandbox', async () => {
    const tool = resolveTool('file-write');
    const result = await tool.execute({ path: '../escaped.txt', content: 'pwn' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes workspace sandbox');
  });

  it('file-read rejects absolute path outside the workspace', async () => {
    const tool = resolveTool('file-read');
    const result = await tool.execute({ path: '/etc/hosts' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes workspace sandbox');
  });
});

describe('core tool: calculator', () => {
  const ctx = makeCtx(tmpdir());

  it('evaluates arithmetic without dynamic code execution', async () => {
    const tool = resolveTool('calculator');
    const result = await tool.execute({ expression: '2 + 3 * (4 - 1)^2', precision: 2 }, ctx);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      expression: '2 + 3 * (4 - 1)^2',
      result: 29,
    });
  });

  it('rejects non-arithmetic input', async () => {
    const tool = resolveTool('calculator');
    const result = await tool.execute({ expression: 'process.exit()' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('numbers, operators and parentheses');
  });
});

describe('core tool: http-request', () => {
  const ctx = makeCtx(tmpdir());
  const originalAllowlist = process.env.HTTP_TOOL_ALLOWLIST;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // Extend the allowlist for this test suite so example.com is reachable.
    process.env.HTTP_TOOL_ALLOWLIST = 'example.com';
    process.env.HTTP_TOOL_DNS_CHECK = 'false';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAllowlist === undefined) delete process.env.HTTP_TOOL_ALLOWLIST;
    else process.env.HTTP_TOOL_ALLOWLIST = originalAllowlist;
    delete process.env.HTTP_TOOL_DNS_CHECK;
  });

  it('GET request returns response body with success=true for 2xx', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"data":"result"}',
    } as Response);

    const tool = resolveTool('http-request');
    const result = await tool.execute({ url: 'https://example.com/api' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('{"data":"result"}');
    expect(result.exitCode).toBe(200);
  });

  it('4xx response returns success=false', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    } as Response);

    const tool = resolveTool('http-request');
    const result = await tool.execute({ url: 'https://example.com/missing' }, ctx);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(404);
  });

  it('network error returns success=false with error message', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValue(new Error('Network error'));

    const tool = resolveTool('http-request');
    const result = await tool.execute({ url: 'https://example.com/api' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('rejects URL outside allowlist (default-deny)', async () => {
    delete process.env.HTTP_TOOL_ALLOWLIST; // restore strict default for this test
    const tool = resolveTool('http-request');
    const result = await tool.execute({ url: 'https://attacker.example/exfil' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('rejects private IP range (SSRF guard)', async () => {
    delete process.env.HTTP_TOOL_ALLOWLIST;
    const tool = resolveTool('http-request');
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });
});

describe('core tool: current-time', () => {
  const ctx = makeCtx(tmpdir());

  it('returns an ISO timestamp and timezone-local rendering', async () => {
    const tool = resolveTool('current-time');
    const result = await tool.execute({ timezone: 'UTC' }, ctx);
    const parsed = JSON.parse(result.output) as { iso: string; timezone: string; local: string };

    expect(result.success).toBe(true);
    expect(parsed.timezone).toBe('UTC');
    expect(parsed.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.local.length).toBeGreaterThan(0);
  });

  it('returns a structured error for invalid timezones', async () => {
    const tool = resolveTool('current-time');
    const result = await tool.execute({ timezone: 'Not/A_Timezone' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid timezone');
  });
});

describe('core tool: knowledge-search', () => {
  let sandbox: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'omniforge-knowledge-'));
    ctx = makeCtx(sandbox);
    await mkdir(join(sandbox, 'docs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('returns ranked local snippets with secret scrubbing', async () => {
    await writeFile(
      join(sandbox, 'docs', 'rag.md'),
      [
        '# Local RAG',
        'Retrieval augmented generation helps Omniforge reuse local knowledge safely.',
        'api_key = sk-12345678901234567890123456789012',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(sandbox, 'docs', 'other.md'),
      'This note is about unrelated release planning.',
      'utf8',
    );

    const tool = resolveTool('knowledge-search');
    const result = await tool.execute({ query: 'Omniforge retrieval knowledge', top_k: 2 }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('[Document: docs/rag.md');
    expect(result.output).toContain('Retrieval augmented generation');
    expect(result.output).toContain('[REDACTED]');
    expect(result.output).not.toContain('sk-12345678901234567890123456789012');
  });

  it('rejects a search root outside the workspace sandbox', async () => {
    const tool = resolveTool('knowledge-search');
    const result = await tool.execute({ query: 'anything useful', root: '../outside' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes workspace sandbox');
  });
});

// ---------------------------------------------------------------------------
// Executor integration — tool_call kind
// ---------------------------------------------------------------------------

describe('executor — tool_call integration', () => {
  afterEach(async () => {
    await rm(join(process.cwd(), 'workspaces', '__tooltest__'), { recursive: true, force: true });
  });

  it('task kind=tool_call executes tool and stores JSON output', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'write-file',
          kind: 'tool_call',
          depends_on: [],
          executor_hint: null,
          model: null,
          tool_name: 'bash',
        },
      ],
    };

    let capturedOutput: string | null = null;
    const executeFn = async (t: Task): Promise<string> => {
      // For tool_call, the actual executor dispatches to the tool.
      // Here we override with a mock that simulates the tool output format.
      capturedOutput = t.input_json;
      return JSON.stringify({ success: true, output: 'tool-executed', exitCode: 0 });
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });

    expect(wf.status).toBe('completed');
    // input_json should include tool_name
    expect(capturedOutput).not.toBeNull();
    const ctx = JSON.parse(capturedOutput!) as Record<string, unknown>;
    expect(ctx['tool_name']).toBe('bash');
    db.close();
  });

  it('task kind=tool_call with unknown tool name fails workflow', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'bad-tool',
          kind: 'tool_call',
          depends_on: [],
          executor_hint: null,
          model: null,
          tool_name: 'no-such-tool-xyz',
        },
      ],
    };

    // Do NOT override executeTaskFn — let real runToolCallTask run and fail
    await expect(
      executeWorkflow(db, dag, '__test__', 'x', {
        consolidateFn: async () => 'done',
        autoApprove: true,
        sleepFn: async () => {},
      }),
    ).rejects.toThrow("Tool not found in registry: 'no-such-tool-xyz'");
    db.close();
  });

  it('DagSchema accepts tool_call kind with tool_name field', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const dag = {
      tasks: [{
        id: 't1', name: 'x', kind: 'tool_call', depends_on: [],
        tool_name: 'bash',
      }],
    };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });

  it('DagSchema preserves tool_call args for executor materialisation', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const parsed = DagSchema.parse({
      tasks: [{
        id: 't1',
        name: 'write report',
        kind: 'tool_call',
        depends_on: [],
        tool_name: 'file-write',
        args: { path: 'reports/out.txt', content: 'hello from dag args' },
      }],
    });
    expect(parsed.tasks[0]!.args).toEqual({
      path: 'reports/out.txt',
      content: 'hello from dag args',
    });
  });

  it('DagSchema preserves per-task tool_policy for governance enforcement', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const parsed = DagSchema.parse({
      tasks: [{
        id: 't1',
        name: 'write report',
        kind: 'tool_call',
        depends_on: [],
        tool_name: 'file-write',
        args: { path: 'reports/out.txt', content: 'hello' },
        tool_policy: { tools: { allowed: ['file-read'] } },
      }],
    });
    expect(parsed.tasks[0]!.tool_policy).toEqual({
      tools: { allowed: ['file-read'] },
    });
  });

  it('real tool_call file-write uses DAG args and the workflow workspace sandbox', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 'write',
          name: 'write artifact',
          kind: 'tool_call',
          depends_on: [],
          executor_hint: null,
          model: null,
          tool_name: 'file-write',
          args: { path: 'reports/out.txt', content: 'tool-call-content' },
        },
      ],
    };

    const wf = await executeWorkflow(db, dag, '__tooltest__', 'write a file with a tool', {
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
      costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
    });

    const writtenPath = join(process.cwd(), 'workspaces', '__tooltest__', 'runs', wf.id, 'reports', 'out.txt');
    await expect(readFile(writtenPath, 'utf8')).resolves.toBe('tool-call-content');

    const row = db
      .prepare('SELECT input_json, output_json FROM tasks WHERE workflow_id = ?')
      .get(wf.id) as { input_json: string; output_json: string };
    const input = JSON.parse(row.input_json) as Record<string, unknown>;
    expect(input['workspace']).toBe('__tooltest__');
    expect(input['args']).toEqual({ path: 'reports/out.txt', content: 'tool-call-content' });
    expect(JSON.parse(row.output_json).success).toBe(true);
    db.close();
  });

  it('real tool_call is blocked when the DAG tool_policy denies the tool', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 'write',
          name: 'write artifact',
          kind: 'tool_call',
          depends_on: [],
          executor_hint: null,
          model: null,
          tool_name: 'file-write',
          args: { path: 'reports/out.txt', content: 'blocked' },
          tool_policy: { tools: { allowed: ['file-read'] } },
        } as unknown as Dag['tasks'][number],
      ],
    };

    await expect(
      executeWorkflow(db, dag, '__tooltest__', 'write a file with a denied tool', {
        consolidateFn: async () => 'done',
        autoApprove: true,
        sleepFn: async () => {},
        costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
      }),
    ).rejects.toThrow(/not in allowed tools/i);

    db.close();
  });

  it('real tool_call with require_approval_for opens a HITL gate before executing the tool', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 'write',
          name: 'write approval artifact',
          kind: 'tool_call',
          depends_on: [],
          executor_hint: null,
          model: null,
          tool_name: 'file-write',
          args: { path: 'reports/approved.txt', content: 'approved-content' },
          tool_policy: {
            tools: {
              allowed: ['file-write'],
              require_approval_for: ['file-write'],
            },
          },
        } as unknown as Dag['tasks'][number],
      ],
    };
    const hitlFn = vi.fn(async () => 'approve' as const);

    const wf = await executeWorkflow(db, dag, '__tooltest__', 'write with policy approval', {
      consolidateFn: async () => 'done',
      autoApprove: false,
      hitlFn,
      sleepFn: async () => {},
      costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
    });

    expect(wf.status).toBe('completed');
    expect(hitlFn).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringContaining('file-write'),
    }));
    const writtenPath = join(process.cwd(), 'workspaces', '__tooltest__', 'runs', wf.id, 'reports', 'approved.txt');
    await expect(readFile(writtenPath, 'utf8')).resolves.toBe('approved-content');

    const gates = db
      .prepare('SELECT status, prompt FROM hitl_gates WHERE workflow_id = ?')
      .all(wf.id) as Array<{ status: string; prompt: string }>;
    expect(gates).toEqual([
      expect.objectContaining({
        status: 'approved',
        prompt: expect.stringContaining('file-write'),
      }),
    ]);

    db.close();
  });

  it('real tool_call is blocked by the active versioned tool policy when configured', async () => {
    const originalDbPath = process.env.DB_PATH;
    const originalPolicyName = process.env.OMNIFORGE_TOOL_POLICY_NAME;
    const policyDir = await mkdtemp(join(tmpdir(), 'omniforge-policy-db-'));
    process.env.DB_PATH = join(policyDir, 'omniforge.db');
    process.env.OMNIFORGE_TOOL_POLICY_NAME = 'safe-tools';

    const policyDb = initDb(process.env.DB_PATH);
    const policy = createVersionedDefinition(policyDb, {
      workspace: '__tooltest__',
      kind: 'policy',
      name: 'safe-tools',
      version: '1.0.0',
      spec: { tools: { allowed: ['file-read'] } },
    });
    pinVersionedDefinition(policyDb, {
      workspace: '__tooltest__',
      kind: 'policy',
      name: 'safe-tools',
      versionId: policy.id,
    });
    policyDb.close();

    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 'write',
          name: 'write artifact',
          kind: 'tool_call',
          depends_on: [],
          executor_hint: null,
          model: null,
          tool_name: 'file-write',
          args: { path: 'reports/out.txt', content: 'blocked by active policy' },
        },
      ],
    };

    try {
      await expect(
        executeWorkflow(db, dag, '__tooltest__', 'write with active policy', {
          consolidateFn: async () => 'done',
          autoApprove: true,
          sleepFn: async () => {},
          costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
        }),
      ).rejects.toThrow(/not in allowed tools/i);
    } finally {
      db.close();
      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
      if (originalPolicyName === undefined) delete process.env.OMNIFORGE_TOOL_POLICY_NAME;
      else process.env.OMNIFORGE_TOOL_POLICY_NAME = originalPolicyName;
      await rm(policyDir, { recursive: true, force: true });
    }
  });

  it('DagSchema accepts tool_call kind without tool_name (tool_name optional)', async () => {
    const { DagSchema } = await import('../../src/types/schemas.js');
    const dag = {
      tasks: [{ id: 't1', name: 'x', kind: 'tool_call', depends_on: [] }],
    };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });

  it('V1 path (llm_call) still works — no tool_call regressions', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'step1', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 't2', name: 'step2', kind: 'llm_call', depends_on: ['t1'], executor_hint: null, model: null },
      ],
    };
    let callCount = 0;
    const executeFn = async (): Promise<string> => { callCount++; return `out-${callCount}`; };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    expect(wf.status).toBe('completed');
    expect(callCount).toBe(2);
    db.close();
  });

  it('mixed workflow with llm_call + tool_call completes successfully', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'llm', name: 'analyze', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        {
          id: 'tool', name: 'save-result', kind: 'tool_call', depends_on: ['llm'],
          executor_hint: null, model: null, tool_name: 'file-write',
        },
      ],
    };
    let callCount = 0;
    const executeFn = async (): Promise<string> => {
      callCount++;
      return JSON.stringify({ success: true, output: `executed-${callCount}`, exitCode: 0 });
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    expect(wf.status).toBe('completed');
    expect(callCount).toBe(2);
    db.close();
  });
});
