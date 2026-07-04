/**
 * Unit tests for mcp:<server>:<tool> routing in the core tool registry.
 *
 * The external MCP router is wired by importing
 * `src/v2/tools/core/index.ts` as a side-effect (which calls
 * `setExternalMcpRouter`). We mock `ExternalMcpManager` so no real
 * MCP server is required.
 *
 * Mocks that must be available during vi.mock factory execution are
 * declared via `vi.hoisted()` so they are initialised before the hoisted
 * vi.mock calls run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── vi.hoisted — available inside vi.mock factory closures ──────────────────

const { mockCallPrefixedTool, mockGetInstance } = vi.hoisted(() => {
  const mockCallPrefixedTool = vi.fn();
  const mockGetInstance = vi.fn().mockReturnValue({
    callPrefixedTool: mockCallPrefixedTool,
  });
  return { mockCallPrefixedTool, mockGetInstance };
});

// ── Module mocks (hoisted to file top by vitest) ────────────────────────────

vi.mock('../../src/v2/external-mcp/client.js', () => ({
  ExternalMcpManager: {
    getInstance: mockGetInstance,
  },
  encryptBearer: vi.fn(),
  decryptBearer: vi.fn(),
  ExternalMcpClient: vi.fn(),
}));

vi.mock('../../src/db/persist.js', () => ({
  insertEvent: vi.fn(),
  persistWorkflow: vi.fn(),
  persistTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateWorkflowStatus: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  initDb: vi.fn().mockReturnValue({
    close: vi.fn(),
    prepare: vi.fn().mockReturnValue({ get: vi.fn(), run: vi.fn(), all: vi.fn() }),
  }),
}));

// ── Module imports (after mocks so the router is wired with mocks active) ───

// Side-effect import: registers all core tools AND calls setExternalMcpRouter.
import '../../src/v2/tools/core/index.js';
import { resolveTool, getExternalMcpRouter } from '../../src/v2/tools/registry.js';
import { insertEvent } from '../../src/db/persist.js';
import { initDb } from '../../src/db/client.js';
import type { ToolContext } from '../../src/v2/tools/registry.js';

const mockInsertEvent = vi.mocked(insertEvent);
const mockInitDb = vi.mocked(initDb);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): ToolContext {
  return {
    workspaceRoot: '/tmp/test-workspace',
    workspace: '__test__',
    workflowId: 'wf_routing_test',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('external MCP tool routing (mcp:<server>:<tool>)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock return values after clearAllMocks resets them.
    mockGetInstance.mockReturnValue({ callPrefixedTool: mockCallPrefixedTool });
    mockInitDb.mockReturnValue({
      close: vi.fn(),
      prepare: vi.fn().mockReturnValue({ get: vi.fn(), run: vi.fn(), all: vi.fn() }),
    } as unknown as ReturnType<typeof initDb>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Router registration ─────────────────────────────────────────────

  it('registers the external MCP router at module load time', () => {
    expect(getExternalMcpRouter()).not.toBeNull();
  });

  // ── mcp: prefix is intercepted ──────────────────────────────────────

  it('resolveTool("mcp:my-server:search") returns a synthetic ToolDefinition', () => {
    const tool = resolveTool('mcp:my-server:search');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('mcp:my-server:search');
    expect(typeof tool.execute).toBe('function');
  });

  it('executes mcp:my-server:search via callPrefixedTool', async () => {
    mockCallPrefixedTool.mockResolvedValueOnce({
      content: 'search results',
      isError: false,
    });

    const tool = resolveTool('mcp:my-server:search');
    const result = await tool.execute({ query: 'typescript' }, makeCtx());

    expect(mockCallPrefixedTool).toHaveBeenCalledOnce();
    expect(mockCallPrefixedTool).toHaveBeenCalledWith(
      'mcp:my-server:search',
      { query: 'typescript' },
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe('search results');
    expect(result.error).toBeUndefined();
  });

  it('JSON-serialises non-string content', async () => {
    mockCallPrefixedTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    });

    const tool = resolveTool('mcp:my-server:list');
    const result = await tool.execute({}, makeCtx());

    expect(result.success).toBe(true);
    expect(result.output).toBe(JSON.stringify([{ type: 'text', text: 'result' }]));
  });

  it('maps isError=true to success=false and populates error field', async () => {
    mockCallPrefixedTool.mockResolvedValueOnce({
      content: 'tool-level error message',
      isError: true,
    });

    const tool = resolveTool('mcp:my-server:broken');
    const result = await tool.execute({}, makeCtx());

    expect(result.success).toBe(false);
    expect(result.output).toBe('tool-level error message');
    expect(result.error).toBe('tool-level error message');
  });

  it('emits external_mcp_tool_called audit event on success', async () => {
    mockCallPrefixedTool.mockResolvedValueOnce({
      content: 'ok',
      isError: false,
    });

    const tool = resolveTool('mcp:my-server:search');
    await tool.execute({ q: 'test' }, makeCtx());

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [_db, evArg] = mockInsertEvent.mock.calls[0] as [
      unknown,
      { type: string; workflow_id: string },
    ];
    expect(evArg.type).toBe('external_mcp_tool_called');
    expect(evArg.workflow_id).toBe('wf_routing_test');
  });

  // ── Failure handling ────────────────────────────────────────────────

  it('emits external_mcp_tool_error audit event when callPrefixedTool throws', async () => {
    mockCallPrefixedTool.mockRejectedValueOnce(new Error('connection refused'));

    const tool = resolveTool('mcp:down-server:ping');
    await expect(tool.execute({}, makeCtx())).rejects.toThrow('connection refused');

    expect(mockInsertEvent).toHaveBeenCalledOnce();
    const [_db, evArg] = mockInsertEvent.mock.calls[0] as [
      unknown,
      { type: string; payload: { error: string } },
    ];
    expect(evArg.type).toBe('external_mcp_tool_error');
    expect(evArg.payload.error).toContain('connection refused');
  });

  it('re-throws the original error after emitting the audit event', async () => {
    const originalError = new Error('network timeout');
    mockCallPrefixedTool.mockRejectedValueOnce(originalError);

    const tool = resolveTool('mcp:slow-server:query');
    await expect(tool.execute({}, makeCtx())).rejects.toBe(originalError);
  });

  // ── Regular tool names are NOT intercepted ──────────────────────────

  it('resolveTool("bash") resolves the in-process bash tool, not external MCP', () => {
    // bash is registered by importing index.ts (already done at top of file).
    const tool = resolveTool('bash');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('bash');
    // Must NOT have delegated to the mock manager.
    expect(mockGetInstance).not.toHaveBeenCalled();
    expect(mockCallPrefixedTool).not.toHaveBeenCalled();
  });

  it('resolveTool with unknown non-mcp name throws "Tool not found"', () => {
    expect(() => resolveTool('no-such-tool')).toThrow(/Tool not found in registry/);
  });

  // ── Synthetic ToolDefinition argsSchema ────────────────────────────

  it('synthetic tool argsSchema accepts any object', () => {
    const tool = resolveTool('mcp:my-server:anything');
    const parseResult = tool.argsSchema.safeParse({ a: 1, b: 'two', c: true });
    expect(parseResult.success).toBe(true);
  });

  it('synthetic tool argsSchema rejects non-object input', () => {
    const tool = resolveTool('mcp:my-server:anything');
    const parseResult = tool.argsSchema.safeParse('not-an-object');
    expect(parseResult.success).toBe(false);
  });
});
