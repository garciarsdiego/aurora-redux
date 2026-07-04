import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { GetWorkflowStatusSchema } from '../../src/mcp/tools/get_workflow_status.js';
import { ListWorkflowsSchema } from '../../src/mcp/tools/list_workflows.js';
import { TOOLS } from '../../src/mcp/server.js';

// ── Shared mock db ──────────────────────────────────────────────────────────

const mockStmt = { get: vi.fn(), all: vi.fn() };
const mockDb = { prepare: vi.fn(() => mockStmt), close: vi.fn() };

vi.mock('../../src/db/client.js', () => ({
  initDb: vi.fn(() => mockDb),
}));

vi.mock('../../src/utils/config.js', () => ({
  getDbPath: vi.fn(() => ':memory:'),
}));

vi.mock('../../src/db/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/persist.js')>();
  return {
    ...actual,
    loadWorkflowById: vi.fn(),
    loadWorkflowTasks: vi.fn(),
  };
});

// ── TOOLS registration ──────────────────────────────────────────────────────

describe('TOOLS list', () => {
  it('contains omniforge_get_workflow_status', () => {
    expect(TOOLS.map((t) => t.name)).toContain('omniforge_get_workflow_status');
  });

  it('contains omniforge_list_workflows', () => {
    expect(TOOLS.map((t) => t.name)).toContain('omniforge_list_workflows');
  });

  it('omniforge_get_workflow_status requires workflow_id', () => {
    const tool = TOOLS.find((t) => t.name === 'omniforge_get_workflow_status')!;
    expect(tool.inputSchema.required).toContain('workflow_id');
  });
});

// ── GetWorkflowStatusSchema ─────────────────────────────────────────────────

describe('GetWorkflowStatusSchema', () => {
  it('parses a valid workflow_id', () => {
    const result = GetWorkflowStatusSchema.parse({ workflow_id: 'wf_abc123' });
    expect(result.workflow_id).toBe('wf_abc123');
  });

  it('rejects empty workflow_id', () => {
    expect(() => GetWorkflowStatusSchema.parse({ workflow_id: '' })).toThrow(ZodError);
  });

  it('rejects missing workflow_id', () => {
    expect(() => GetWorkflowStatusSchema.parse({})).toThrow(ZodError);
  });
});

// ── ListWorkflowsSchema ─────────────────────────────────────────────────────

describe('ListWorkflowsSchema', () => {
  it('parses empty input with defaults', () => {
    const result = ListWorkflowsSchema.parse({});
    expect(result.workspace).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.limit).toBe(20);
  });

  it('parses all optional fields', () => {
    const result = ListWorkflowsSchema.parse({
      workspace: 'internal',
      status: 'completed',
      limit: 5,
    });
    expect(result.workspace).toBe('internal');
    expect(result.status).toBe('completed');
    expect(result.limit).toBe(5);
  });

  it('rejects limit above 100', () => {
    expect(() => ListWorkflowsSchema.parse({ limit: 101 })).toThrow(ZodError);
  });

  it('rejects limit below 1', () => {
    expect(() => ListWorkflowsSchema.parse({ limit: 0 })).toThrow(ZodError);
  });
});

// ── getWorkflowStatusTool ───────────────────────────────────────────────────

describe('getWorkflowStatusTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error JSON when workflow not found', async () => {
    const { loadWorkflowById } = await import('../../src/db/persist.js');
    vi.mocked(loadWorkflowById).mockReturnValue(null);

    const { getWorkflowStatusTool } = await import('../../src/mcp/tools/get_workflow_status.js');
    const result = await getWorkflowStatusTool({ workflow_id: 'wf_nonexistent' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/not found/i);
  });

  it('returns workflow structure when found', async () => {
    const { loadWorkflowById, loadWorkflowTasks } = await import('../../src/db/persist.js');

    vi.mocked(loadWorkflowById).mockReturnValue({
      id: 'wf_001',
      workspace: 'internal',
      objective: 'test objective',
      status: 'completed',
      pattern_id: null,
      started_at: 1000,
      completed_at: 2000,
      created_at: 900,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    });

    vi.mocked(loadWorkflowTasks).mockReturnValue([
      {
        id: 'tk_001',
        workflow_id: 'wf_001',
        name: 'task one',
        kind: 'llm_call',
        status: 'completed',
        input_json: null,
        output_json: null,
        depends_on: [],
        executor_hint: null,
        timeout_seconds: 60,
        max_retries: 2,
        retry_count: 0,
        retry_policy: 'linear',
        started_at: 1100,
        completed_at: 1900,
        created_at: 950,
        acceptance_criteria: null,
        refine_count: 0,
        max_refine: 0,
        refine_feedback: null,
        model: null,
        hitl: false,
      },
    ]);

    mockStmt.all.mockReturnValue([]);

    const { getWorkflowStatusTool } = await import('../../src/mcp/tools/get_workflow_status.js');
    const result = await getWorkflowStatusTool({ workflow_id: 'wf_001' });
    const parsed = JSON.parse(result);

    expect(parsed.workflow_id).toBe('wf_001');
    expect(parsed.status).toBe('completed');
    expect(parsed.workspace).toBe('internal');
    expect(parsed.task_count).toBe(1);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]).toMatchObject({ id: 'tk_001', name: 'task one', status: 'completed' });
    expect(Array.isArray(parsed.recent_events)).toBe(true);
  });
});

// ── listWorkflowsTool ───────────────────────────────────────────────────────

describe('listWorkflowsTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no workflows exist', async () => {
    mockStmt.all.mockReturnValue([]);
    mockDb.prepare.mockReturnValue(mockStmt);

    const { listWorkflowsTool } = await import('../../src/mcp/tools/list_workflows.js');
    const result = await listWorkflowsTool({});
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it('returns workflows with expected shape', async () => {
    mockStmt.all.mockReturnValue([
      {
        id: 'wf_001',
        workspace: 'internal',
        objective: 'do something',
        status: 'completed',
        started_at: 1000,
        created_at: 900,
        task_count: 3,
      },
    ]);
    mockDb.prepare.mockReturnValue(mockStmt);

    const { listWorkflowsTool } = await import('../../src/mcp/tools/list_workflows.js');
    const result = await listWorkflowsTool({});
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      workflow_id: 'wf_001',
      workspace: 'internal',
      status: 'completed',
      task_count: 3,
    });
  });

  it('passes workspace filter to query', async () => {
    mockStmt.all.mockReturnValue([]);
    mockDb.prepare.mockReturnValue(mockStmt);

    const { listWorkflowsTool } = await import('../../src/mcp/tools/list_workflows.js');
    await listWorkflowsTool({ workspace: 'globex' });

    const sql = mockDb.prepare.mock.calls[0]?.[0] as string;
    expect(sql).toContain('WHERE');
    // verify globex was passed as bind param
    const callArgs = mockStmt.all.mock.calls[0] as unknown[];
    expect(callArgs).toContain('globex');
  });

  it('passes status filter to query', async () => {
    mockStmt.all.mockReturnValue([]);
    mockDb.prepare.mockReturnValue(mockStmt);

    const { listWorkflowsTool } = await import('../../src/mcp/tools/list_workflows.js');
    await listWorkflowsTool({ status: 'failed' });

    const callArgs = mockStmt.all.mock.calls[0] as unknown[];
    expect(callArgs).toContain('failed');
  });
});
