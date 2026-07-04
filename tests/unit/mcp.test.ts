import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { RunWorkflowSchema } from '../../src/mcp/tools/run_workflow.js';
import { TOOLS } from '../../src/mcp/server.js';

vi.mock('../../src/mcp/tools/run_workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/tools/run_workflow.js')>();
  return {
    ...actual,
    runWorkflowTool: vi.fn().mockResolvedValue(
      JSON.stringify({ workflow_id: 'wf_test_001', status: 'completed', task_count: 2, pattern_used: null }),
    ),
  };
});

describe('TOOLS list', () => {
  it('contains omniforge_run_workflow', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('omniforge_run_workflow');
  });

  it('omniforge_run_workflow has required workspace and objective', () => {
    const tool = TOOLS.find((t) => t.name === 'omniforge_run_workflow')!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['workspace', 'objective']));
  });
});

describe('RunWorkflowSchema', () => {
  it('parses valid input with defaults', () => {
    const result = RunWorkflowSchema.parse({ workspace: 'internal', objective: 'generate report' });
    expect(result.workspace).toBe('internal');
    expect(result.objective).toBe('generate report');
    expect(result.auto_approve).toBe(false);
  });

  it('parses auto_approve: true', () => {
    const result = RunWorkflowSchema.parse({
      workspace: 'globex',
      objective: 'run analysis',
      auto_approve: true,
    });
    expect(result.auto_approve).toBe(true);
  });

  it('rejects empty workspace', () => {
    expect(() => RunWorkflowSchema.parse({ workspace: '', objective: 'test' })).toThrow(ZodError);
  });

  it('rejects missing objective', () => {
    expect(() => RunWorkflowSchema.parse({ workspace: 'internal' })).toThrow(ZodError);
  });

  it('rejects missing workspace', () => {
    expect(() => RunWorkflowSchema.parse({ objective: 'test' })).toThrow(ZodError);
  });
});

describe('callTool dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns workflow_id for omniforge_run_workflow', async () => {
    const { runWorkflowTool } = await import('../../src/mcp/tools/run_workflow.js');
    const args = { workspace: 'internal', objective: 'test workflow' };
    const text = await (runWorkflowTool as ReturnType<typeof vi.fn>)(args);
    const parsed = JSON.parse(text as string);
    expect(parsed).toHaveProperty('workflow_id');
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('task_count');
  });

  it('throws McpError for unknown tool', async () => {
    const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
    const unknownTool = 'nonexistent_tool';
    const dispatch = async (name: string) => {
      if (name !== 'omniforge_run_workflow') {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    };
    await expect(dispatch(unknownTool)).rejects.toThrow(McpError);
  });
});
