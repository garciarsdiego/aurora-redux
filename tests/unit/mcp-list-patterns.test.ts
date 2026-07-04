import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { ListPatternsSchema } from '../../src/mcp/tools/list_patterns.js';
import { TOOLS } from '../../src/mcp/server.js';

// ── Mock db ─────────────────────────────────────────────────────────────────

const mockDb = { close: vi.fn() };

vi.mock('../../src/db/client.js', () => ({
  initDb: vi.fn(() => mockDb),
}));

vi.mock('../../src/utils/config.js', () => ({
  getDbPath: vi.fn(() => ':memory:'),
}));

vi.mock('../../src/db/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/persist.js')>();
  return { ...actual, listPatternsByWorkspace: vi.fn() };
});

// ── TOOLS registration ──────────────────────────────────────────────────────

describe('TOOLS list', () => {
  it('contains omniforge_list_patterns', () => {
    expect(TOOLS.map((t) => t.name)).toContain('omniforge_list_patterns');
  });

  it('omniforge_list_patterns requires workspace', () => {
    const tool = TOOLS.find((t) => t.name === 'omniforge_list_patterns')!;
    expect(tool.inputSchema.required).toContain('workspace');
  });

  it('omniforge_list_patterns does not require limit', () => {
    const tool = TOOLS.find((t) => t.name === 'omniforge_list_patterns')!;
    expect(tool.inputSchema.required).not.toContain('limit');
  });
});

// ── ListPatternsSchema ──────────────────────────────────────────────────────

describe('ListPatternsSchema', () => {
  it('parses workspace with default limit', () => {
    const r = ListPatternsSchema.parse({ workspace: 'internal' });
    expect(r.workspace).toBe('internal');
    expect(r.limit).toBe(20);
  });

  it('parses explicit limit', () => {
    const r = ListPatternsSchema.parse({ workspace: 'globex', limit: 5 });
    expect(r.limit).toBe(5);
  });

  it('rejects limit above 50', () => {
    expect(() => ListPatternsSchema.parse({ workspace: 'x', limit: 51 })).toThrow(ZodError);
  });

  it('rejects limit below 1', () => {
    expect(() => ListPatternsSchema.parse({ workspace: 'x', limit: 0 })).toThrow(ZodError);
  });

  it('rejects missing workspace', () => {
    expect(() => ListPatternsSchema.parse({})).toThrow(ZodError);
  });

  it('rejects empty workspace', () => {
    expect(() => ListPatternsSchema.parse({ workspace: '' })).toThrow(ZodError);
  });
});

// ── listPatternsTool ────────────────────────────────────────────────────────

describe('listPatternsTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when no patterns exist', async () => {
    const { listPatternsByWorkspace } = await import('../../src/db/persist.js');
    vi.mocked(listPatternsByWorkspace).mockReturnValue([]);

    const { listPatternsTool } = await import('../../src/mcp/tools/list_patterns.js');
    const result = await listPatternsTool({ workspace: 'internal' });
    expect(JSON.parse(result)).toEqual([]);
  });

  it('returns patterns with expected shape', async () => {
    const { listPatternsByWorkspace } = await import('../../src/db/persist.js');
    vi.mocked(listPatternsByWorkspace).mockReturnValue([
      {
        id: 'pt_001',
        name: 'weekly report',
        workspace: 'internal',
        source: 'generated',
        objective_sample: 'generate weekly report',
        dag_json: '{}',
        usage_count: 5,
        success_count: 4,
        avg_duration_ms: 3000,
        last_used_at: 1000,
        created_at: 500,
      },
    ]);

    const { listPatternsTool } = await import('../../src/mcp/tools/list_patterns.js');
    const result = await listPatternsTool({ workspace: 'internal' });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 'pt_001',
      name: 'weekly report',
      workspace: 'internal',
      usage_count: 5,
      success_count: 4,
    });
    // dag_json and source should NOT be in the response
    expect(parsed[0]).not.toHaveProperty('dag_json');
    expect(parsed[0]).not.toHaveProperty('source');
  });

  it('respects limit via slice', async () => {
    const { listPatternsByWorkspace } = await import('../../src/db/persist.js');
    const manyPatterns = Array.from({ length: 10 }, (_, i) => ({
      id: `pt_${i}`,
      name: `pattern ${i}`,
      workspace: 'internal',
      source: 'generated' as const,
      objective_sample: `sample ${i}`,
      dag_json: '{}',
      usage_count: i,
      success_count: i,
      avg_duration_ms: null,
      last_used_at: null,
      created_at: i,
    }));
    vi.mocked(listPatternsByWorkspace).mockReturnValue(manyPatterns);

    const { listPatternsTool } = await import('../../src/mcp/tools/list_patterns.js');
    const result = await listPatternsTool({ workspace: 'internal', limit: 3 });
    expect(JSON.parse(result)).toHaveLength(3);
  });

  it('passes workspace to listPatternsByWorkspace', async () => {
    const { listPatternsByWorkspace } = await import('../../src/db/persist.js');
    vi.mocked(listPatternsByWorkspace).mockReturnValue([]);

    const { listPatternsTool } = await import('../../src/mcp/tools/list_patterns.js');
    await listPatternsTool({ workspace: 'globex' });

    expect(vi.mocked(listPatternsByWorkspace)).toHaveBeenCalledWith(mockDb, 'globex');
  });
});
