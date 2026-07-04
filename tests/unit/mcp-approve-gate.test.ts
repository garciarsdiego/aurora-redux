import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { ApproveGateSchema } from '../../src/mcp/tools/approve_gate.js';
import { TOOLS } from '../../src/mcp/server.js';

// ── Shared mock db ──────────────────────────────────────────────────────────

const mockStmt = { get: vi.fn(), run: vi.fn() };
const mockDb = { prepare: vi.fn(() => mockStmt), close: vi.fn() };

vi.mock('../../src/db/client.js', () => ({
  initDb: vi.fn(() => mockDb),
}));

vi.mock('../../src/utils/config.js', () => ({
  getDbPath: vi.fn(() => ':memory:'),
}));

vi.mock('../../src/db/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/persist.js')>();
  return { ...actual, resolveHitlGate: vi.fn() };
});

// ── TOOLS registration ──────────────────────────────────────────────────────

describe('TOOLS list', () => {
  it('contains omniforge_approve_gate', () => {
    expect(TOOLS.map((t) => t.name)).toContain('omniforge_approve_gate');
  });

  it('omniforge_approve_gate requires gate_id and decision', () => {
    const tool = TOOLS.find((t) => t.name === 'omniforge_approve_gate')!;
    expect(tool.inputSchema.required).toContain('gate_id');
    expect(tool.inputSchema.required).toContain('decision');
  });

  it('omniforge_approve_gate advertises modify in its MCP schema', () => {
    const tool = TOOLS.find((t) => t.name === 'omniforge_approve_gate')!;
    expect(tool.inputSchema.properties.decision.enum).toContain('modify');
  });
});

// ── ApproveGateSchema ───────────────────────────────────────────────────────

describe('ApproveGateSchema', () => {
  it('parses approve decision', () => {
    const r = ApproveGateSchema.parse({ gate_id: 'hg_001', decision: 'approve' });
    expect(r.gate_id).toBe('hg_001');
    expect(r.decision).toBe('approve');
    expect(r.feedback).toBeUndefined();
  });

  it('parses reject with feedback', () => {
    const r = ApproveGateSchema.parse({ gate_id: 'hg_002', decision: 'reject', feedback: 'wrong output' });
    expect(r.decision).toBe('reject');
    expect(r.feedback).toBe('wrong output');
  });

  it('rejects unknown decision value', () => {
    expect(() => ApproveGateSchema.parse({ gate_id: 'hg_001', decision: 'maybe' })).toThrow(ZodError);
  });

  it('parses modify decision with feedback', () => {
    const r = ApproveGateSchema.parse({ gate_id: 'hg_003', decision: 'modify', feedback: 'adjust plan' });
    expect(r.decision).toBe('modify');
    expect(r.feedback).toBe('adjust plan');
  });

  it('rejects empty gate_id', () => {
    expect(() => ApproveGateSchema.parse({ gate_id: '', decision: 'approve' })).toThrow(ZodError);
  });

  it('rejects missing gate_id', () => {
    expect(() => ApproveGateSchema.parse({ decision: 'approve' })).toThrow(ZodError);
  });

  it('rejects missing decision', () => {
    expect(() => ApproveGateSchema.parse({ gate_id: 'hg_001' })).toThrow(ZodError);
  });
});

// ── approveGateTool ─────────────────────────────────────────────────────────

describe('approveGateTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when gate not found', async () => {
    mockStmt.get.mockReturnValue(undefined);
    mockDb.prepare.mockReturnValue(mockStmt);

    const { approveGateTool } = await import('../../src/mcp/tools/approve_gate.js');
    const result = await approveGateTool({ gate_id: 'hg_nonexistent', decision: 'approve' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/not found/i);
  });

  it('returns error when gate already resolved', async () => {
    mockStmt.get.mockReturnValue({ id: 'hg_001', status: 'approved', context_json: null });
    mockDb.prepare.mockReturnValue(mockStmt);

    const { approveGateTool } = await import('../../src/mcp/tools/approve_gate.js');
    const result = await approveGateTool({ gate_id: 'hg_001', decision: 'approve' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/already resolved/i);
  });

  it('calls resolveHitlGate with "approved" for approve decision', async () => {
    mockStmt.get.mockReturnValue({ id: 'hg_002', status: 'pending', context_json: null });
    mockDb.prepare.mockReturnValue(mockStmt);

    const { resolveHitlGate } = await import('../../src/db/persist.js');
    const { approveGateTool } = await import('../../src/mcp/tools/approve_gate.js');
    await approveGateTool({ gate_id: 'hg_002', decision: 'approve' });

    expect(vi.mocked(resolveHitlGate)).toHaveBeenCalledWith(mockDb, 'hg_002', 'approved');
  });

  it('calls resolveHitlGate with "rejected" for reject decision', async () => {
    mockStmt.get.mockReturnValue({ id: 'hg_003', status: 'pending', context_json: null });
    mockDb.prepare.mockReturnValue(mockStmt);

    const { resolveHitlGate } = await import('../../src/db/persist.js');
    const { approveGateTool } = await import('../../src/mcp/tools/approve_gate.js');
    await approveGateTool({ gate_id: 'hg_003', decision: 'reject' });

    expect(vi.mocked(resolveHitlGate)).toHaveBeenCalledWith(mockDb, 'hg_003', 'rejected');
  });

  it('returns resolved: true on success', async () => {
    mockStmt.get.mockReturnValue({ id: 'hg_004', status: 'pending', context_json: null });
    mockDb.prepare.mockReturnValue(mockStmt);

    const { approveGateTool } = await import('../../src/mcp/tools/approve_gate.js');
    const result = await approveGateTool({ gate_id: 'hg_004', decision: 'approve' });
    const parsed = JSON.parse(result);

    expect(parsed.gate_id).toBe('hg_004');
    expect(parsed.decision).toBe('approved');
    expect(parsed.resolved).toBe(true);
  });

  it('stores feedback in context_json when provided', async () => {
    mockStmt.get.mockReturnValue({ id: 'hg_005', status: 'pending', context_json: '{"prev":1}' });
    mockDb.prepare.mockReturnValue(mockStmt);

    const { approveGateTool } = await import('../../src/mcp/tools/approve_gate.js');
    await approveGateTool({ gate_id: 'hg_005', decision: 'reject', feedback: 'output was wrong' });

    // prepare should be called for: status query, resolveHitlGate internally, feedback UPDATE
    const updateCall = mockStmt.run.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('output was wrong'),
    );
    expect(updateCall).toBeDefined();
  });
});
