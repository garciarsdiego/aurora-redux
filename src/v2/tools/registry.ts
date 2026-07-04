import { z } from 'zod';

export interface ToolResult {
  success: boolean;
  output: string;
  exitCode?: number;
  error?: string;
}

// Workspace-scoped context handed to every tool execute. Lets tools confine
// filesystem/process actions to the workflow's own runs/<wfId>/ root and
// reject paths that escape it. See docs/audit/REFACTORING_PROPOSALS.md § 1.
export interface ToolContext {
  workspaceRoot: string;
  workspace: string;
  workflowId: string;
  // EXEC-04: optional cancel signal. Threaded by src/executors/tool.ts from the
  // composed workflow-cancel+timeout signal so long-running side-effecting tools
  // (bash, http-request) abort promptly instead of running to their own internal
  // timeout after a workflow cancel. Absent for callers that don't supply one
  // (tests, external-mcp router) — tools must treat undefined as "no cancel".
  signal?: AbortSignal;
  // Aurora-parity Wave 0 (WS3): optional per-execution tool allowlist. When set,
  // ONLY these tool names may run for this task; everything else is denied. This
  // is the scoping substrate for unattended / sub-agent / Wait-1 constrained runs
  // (e.g. a repo-test-runner task granted only the tools it needs). undefined =
  // inherit-all (no restriction) so existing flows are unaffected.
  allowedTools?: string[];
}

/**
 * Tool-allowlist gate (Aurora-parity Wave 0 / WS3). Returns true when the tool
 * is permitted. `allowedTools === undefined` means "inherit all" (no scoping) —
 * the default, so unscoped callers are never restricted. An empty array means
 * "deny everything" (a fully-locked-down agent). mcp:<server>:<tool> names are
 * matched either exactly or by their bare server-prefixed name.
 */
export function isToolAllowed(toolName: string, allowedTools: string[] | undefined): boolean {
  if (allowedTools === undefined) return true;
  return allowedTools.includes(toolName);
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  argsSchema: z.ZodType<TArgs>;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool<TArgs>(def: ToolDefinition<TArgs>): void {
  registry.set(def.name, def as ToolDefinition);
}

// ───────────────────────────────────────────────────────────────────────
// External MCP router plug-in (mcp:<server>:<tool> prefix routing).
//
// `src/v2/tools/core/index.ts` calls `setExternalMcpRouter()` at module
// load time, wiring in the ExternalMcpManager-backed handler. Using this
// indirection avoids importing the heavy external-mcp stack here in the
// registry (which is imported from many paths, including tests that mock
// tools without needing MCP connectivity).
// ───────────────────────────────────────────────────────────────────────

type ExternalMcpRouterFn = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

let _externalMcpRouter: ExternalMcpRouterFn | null = null;

/**
 * Register the external MCP routing function. Called once at startup by
 * `src/v2/tools/core/index.ts` after it imports `ExternalMcpManager`.
 */
export function setExternalMcpRouter(fn: ExternalMcpRouterFn): void {
  _externalMcpRouter = fn;
}

/** Return the registered external MCP router, or null if not wired. */
export function getExternalMcpRouter(): ExternalMcpRouterFn | null {
  return _externalMcpRouter;
}

/**
 * Resolve a tool by name. For `mcp:<server>:<tool>` prefixed names the
 * external MCP router (registered via `setExternalMcpRouter`) is returned
 * wrapped as a synthetic `ToolDefinition`. Throws if the router has not been
 * wired yet or if the in-process tool is not found.
 */
export function resolveTool(name: string): ToolDefinition {
  // External MCP prefix: delegate to the router if wired.
  if (name.startsWith('mcp:')) {
    const router = _externalMcpRouter;
    if (!router) {
      throw new Error(
        `External MCP router not registered. ` +
        `Ensure 'src/v2/tools/core/index.ts' is imported before dispatching mcp: tools. ` +
        `Tool name: '${name}'`,
      );
    }
    // Synthesise a ToolDefinition whose execute delegates to the router.
    const syntheticTool: ToolDefinition<Record<string, unknown>> = {
      name,
      description: `External MCP tool: ${name}`,
      argsSchema: z.record(z.string(), z.unknown()),
      execute: (args, ctx) => router(name, args, ctx),
    };
    return syntheticTool as ToolDefinition;
  }

  const tool = registry.get(name);
  if (!tool) throw new Error(`Tool not found in registry: '${name}'`);
  return tool;
}

export function listTools(): string[] {
  return [...registry.keys()];
}
