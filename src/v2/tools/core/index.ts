import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { registerTool, setExternalMcpRouter, type ToolResult, type ToolContext } from '../registry.js';
import { ExternalMcpManager } from '../../external-mcp/client.js';
import { parsePrefixedToolName } from '../../external-mcp/types.js';
import type { ExternalMcpCallResult } from '../../external-mcp/types.js';
import { resolveSafeWorkspacePath } from './sandbox-path.js';
import { assertToolEnabled, bestEffortAuditEvent, ToolDisabledError } from './tool-policy.js';
// Named import (not just side-effect): reuses the SSRF address-range guard
// below for the http-request tool's isPrivateHost check.
import { isBlockedResolvedAddress } from './web-fetch.js';

// Side-effect imports: each module registers its tool at top level.
import './web-search.js';
import './glob.js';
import './grep.js';
import './apply-patch.js';
import './calculator.js';
import './knowledge-search.js';

// Re-exported for any caller importing ToolDisabledError from this module's
// path (its historical home) — the class itself now lives in tool-policy.ts.
export { ToolDisabledError };

const execFileAsync = promisify(execFile);

// ───────────────────────────────────────────────────────────────────────
// External MCP tool routing (mcp:<server>:<tool> prefix)
// ───────────────────────────────────────────────────────────────────────

/**
 * Execute a tool whose name carries the `mcp:<server>:<tool>` prefix by
 * delegating to `ExternalMcpManager`. Audit events are written to the
 * workflow's event log so the operator can trace every external MCP call.
 *
 * The DB is opened and closed per call (matching the pattern used by
 * `assertToolEnabled` in ./tool-policy.js) because `ToolContext` does not
 * carry a DB handle — the context is workspace-scoped, not DB-scoped.
 */
async function runExternalMcpTool(
  prefixedName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // parsePrefixedToolName validates the mcp:<server>:<tool> shape.
  const parsed = parsePrefixedToolName(prefixedName);
  if (!parsed) {
    return {
      success: false,
      output: '',
      error: `external-mcp: invalid prefixed tool name '${prefixedName}' — expected mcp:<server>:<tool>`,
    };
  }

  const manager = ExternalMcpManager.getInstance();
  let result: ExternalMcpCallResult;
  try {
    result = await manager.callPrefixedTool(prefixedName, args);
  } catch (err) {
    bestEffortAuditEvent(ctx.workflowId, 'external_mcp_tool_error', {
      tool: prefixedName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  bestEffortAuditEvent(ctx.workflowId, 'external_mcp_tool_called', {
    tool: prefixedName,
    is_error: result.isError,
  });

  const output =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content);

  return {
    success: !result.isError,
    output,
    ...(result.isError ? { error: output } : {}),
  };
}

// Wire the external MCP router into the registry at module-load time.
// Any code that imports this module (even as a side-effect) will have the
// router registered before the first tool call.
setExternalMcpRouter(runExternalMcpTool);

// ───────────────────────────────────────────────────────────────────────
// Setup → Tools toggle enforcement (M1 Wave 2, gap B4)
// ───────────────────────────────────────────────────────────────────────
// ToolDisabledError / assertToolEnabled now live in ./tool-policy.js
// (shared with calculator.ts and knowledge-search.ts, which also gate on
// it — see the import above).

// ───────────────────────────────────────────────────────────────────────
// Sandbox helpers
// ───────────────────────────────────────────────────────────────────────
// resolveSafeWorkspacePath now lives in ./sandbox-path.js (shared with
// grep.ts, glob.ts and apply-patch.ts).

// Allowlist for `bash`. Anything else returns a structured failure rather
// than executing. `INJECTION_SCAN_ENFORCE=false` does not relax this — bash
// outside the allowlist requires editing this list explicitly.
const BASH_ALLOWED_BINS = new Set<string>([
  // Runtimes + package managers.
  'node', 'pnpm', 'npm', 'npx', 'tsx', 'tsc',
  'python', 'python3', 'py', 'pip', 'pip3',
  'yarn', 'bun',
  // Test + lint tooling.
  'pytest', 'ruff', 'mypy', 'eslint', 'prettier',
  'vitest', 'jest', 'mocha',
  // Source-of-truth tools.
  'git', 'rg', 'jq',
  // Container & cloud tools.
  'docker', 'docker-compose',
  // Build tools.
  'make', 'cmake', 'cargo', 'rustc', 'go',
  // Network tools.
  'curl', 'wget', 'ssh', 'scp',
  // F-LIVE-4 — read-only coreutils. Safe (no filesystem mutation), and
  // exactly what the decomposer reaches for when asked to verify a file.
  // Still no metacharacter chaining (`&&`, `|`, `;`, etc.) — that gate
  // is enforced separately by SHELL_METACHAR_RE.
  'wc', 'cat', 'head', 'tail', 'ls', 'grep', 'find',
  // F-LIVE-22 — date arithmetic (T1-FACT-004) and text processing
  // (T1-FORMAT-005) blocked by missing allowlist entries. These binaries
  // are read-only / deterministic and carry no filesystem mutation risk.
  // Shell-injection protection is unchanged: SHELL_METACHAR_RE still
  // rejects unquoted `;`, `|`, `&&`, `||`, `$(`, `` ` ``, `>`, `<`, `(`.
  'date', 'printf', 'awk', 'sed', 'sort', 'uniq', 'tr', 'cut',
  // Additional common utilities.
  'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'chown',
  'echo', 'pwd', 'cd', 'which', 'whereis', 'type',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'file', 'stat', 'du', 'df', 'free', 'top', 'htop',
]);

const WINDOWS_CMD_WRAPPERS = new Set<string>([
  'pnpm', 'npm', 'npx', 'tsx', 'tsc',
  'pytest', 'ruff', 'mypy', 'jq',
]);
// Chars that are dangerous OUTSIDE of quoted strings in a shell context.
// We apply this to the raw command string (before quote-stripping) because
// legitimate quoted args such as `awk '{print $1}' file` do NOT contain
// any of these characters — curly braces and `$` inside single quotes are
// inert data, not shell syntax.  What we must catch:
//   &   — background / &&
//   |   — pipe / ||
//   ;   — command separator
//   <   — stdin redirect
//   >   — stdout redirect
//   (   — subshell / $( ) command substitution (the `(` alone is enough)
//   )   — closes subshell
//   `   — backtick command substitution  ← F-LIVE-22 addition
//   \r\n — newline injection
const SHELL_METACHAR_RE = /[&|;<>()`\r\n]/;

function splitCommandLine(command: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function resolveExecutable(bin: string): string {
  if (process.platform === 'win32' && WINDOWS_CMD_WRAPPERS.has(bin)) {
    return `${bin}.cmd`;
  }
  return bin;
}

// SSRF defense — explicit allowlist + reject private IP ranges, including
// hostnames that resolve to private addresses unless HTTP_TOOL_DNS_CHECK=false.
const HTTP_ALLOWED_HOSTS = new Set<string>([
  'localhost', '127.0.0.1',
  'api.telegram.org',
]);
/**
 * True when `hostname` is itself a literal IP address (bracketed IPv6 is
 * unwrapped first) that falls in a blocked range. Domain names fall through
 * to `false` here — they're validated after DNS resolution below, against
 * the addresses that actually come back.
 *
 * Reuses web-fetch.ts's `isBlockedResolvedAddress` (real CIDR/hextet range
 * checks) instead of the previous hand-rolled prefix regex, whose bare
 * `fc|fd` alternative over-blocked any hostname merely starting with those
 * two letters (e.g. an allowlisted 'fdsomething.com' would have been
 * rejected as if it were a fc00::/7 literal).
 */
function isPrivateHost(hostname: string): boolean {
  const candidate =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (!isIPv4(candidate) && !candidate.includes(':')) {
    // Not a literal IP — nothing to block at this stage.
    return false;
  }
  return isBlockedResolvedAddress(candidate);
}

async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  if (process.env.HTTP_TOOL_DNS_CHECK === 'false') return false;
  if (isPrivateHost(hostname)) return true;
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.some((record) => isPrivateHost(record.address));
  } catch {
    return true;
  }
}

async function isHostAllowed(rawUrl: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  // Optional env extension: HTTP_TOOL_ALLOWLIST="host1,host2".
  const envExtra = (process.env.HTTP_TOOL_ALLOWLIST ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const listed = envExtra.includes(url.hostname) || HTTP_ALLOWED_HOSTS.has(url.hostname);
  if (!listed) return false;
  return !(await resolvesToPrivateAddress(url.hostname));
}

// calculator (CalculatorParser + evaluateCalculatorExpression) and
// knowledge-search (KNOWLEDGE_* consts + tokenize/chunk/score/collect
// helpers) now live in their own sibling modules; see the side-effect
// imports at the top of this file.

// ───────────────────────────────────────────────────────────────────────
// Tool registrations
// ───────────────────────────────────────────────────────────────────────

registerTool({
  name: 'bash',
  description: 'Execute a shell command (allowlist: ' + [...BASH_ALLOWED_BINS].join(', ') + ').',
  argsSchema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('bash', ctx);
    if (SHELL_METACHAR_RE.test(args.command)) {
      return {
        success: false,
        output: '',
        exitCode: 1,
        error: 'bash: shell metacharacters are not allowed; pass a single allowlisted command with plain arguments',
      };
    }
    const argv = splitCommandLine(args.command.trim());
    const firstToken = argv[0];
    if (!firstToken) {
      return { success: false, output: '', exitCode: 1, error: 'bash: empty command' };
    }
    if (!BASH_ALLOWED_BINS.has(firstToken)) {
      return {
        success: false,
        output: '',
        exitCode: 1,
        error: `bash: command '${firstToken}' not in allowlist (${[...BASH_ALLOWED_BINS].join(', ')})`,
      };
    }
    let cwd: string;
    try {
      cwd = args.cwd ? resolveSafeWorkspacePath(args.cwd, ctx.workspaceRoot) : path.resolve(ctx.workspaceRoot);
    } catch (err) {
      return { success: false, output: '', exitCode: 1, error: (err as Error).message };
    }
    // EXEC-04: an already-cancelled workflow must not even spawn the child.
    if (ctx.signal?.aborted) {
      return { success: false, output: '', exitCode: 1, error: 'bash: cancelled before execution' };
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        resolveExecutable(firstToken),
        argv.slice(1),
        {
          cwd,
          timeout: args.timeout_ms ?? 30_000,
          maxBuffer: 10 * 1024 * 1024,
          // EXEC-04: Node honors AbortSignal by SIGTERM-killing the child when
          // the workflow is cancelled, instead of waiting out the 30s timeout.
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      );
      return {
        success: true,
        output: stdout + (stderr ? `\nstderr: ${stderr}` : ''),
        exitCode: 0,
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        success: false,
        output: (e.stdout ?? '') + (e.stderr ?? ''),
        exitCode: e.code ?? 1,
        error: e.message,
      };
    }
  },
});

registerTool({
  name: 'file-write',
  description: 'Write content to a file inside the workspace sandbox.',
  argsSchema: z.object({
    path: z.string().min(1),
    content: z.string(),
    encoding: z.enum(['utf8', 'utf-8', 'base64']).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('file-write', ctx);
    let target: string;
    try { target = resolveSafeWorkspacePath(args.path, ctx.workspaceRoot); }
    catch (err) { return { success: false, output: '', error: (err as Error).message }; }

    try {
      const dir = path.dirname(target);
      await mkdir(dir, { recursive: true });

      // Sprint 3.4 (D-H2.066, F-SEC-6): defend against symlink-race between
      // mkdir and writeFile. Resolve realpath of the parent dir AFTER mkdir
      // and assert it still lies inside the workspace sandbox; reject
      // otherwise. This catches the case where an attacker (or a stale
      // workspace state) has planted a symlink in the parent chain that
      // points outside ctx.workspaceRoot.
      const root = path.resolve(ctx.workspaceRoot);
      let realDir: string;
      try { realDir = await realpath(dir); }
      catch { realDir = dir; } // dir was just created; if realpath fails, fall back
      const realRoot = await realpath(root).catch(() => root);
      const rel = path.relative(realRoot, realDir);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return {
          success: false,
          output: '',
          error: `file-write: parent directory escapes workspace sandbox after symlink resolution (realDir=${realDir}, realRoot=${realRoot})`,
        };
      }

      await writeFile(target, args.content, (args.encoding ?? 'utf8') as BufferEncoding);
      return {
        success: true,
        output: `Written ${args.content.length} chars to ${target}`,
      };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, output: '', error: e.message };
    }
  },
});

registerTool({
  name: 'file-read',
  description: 'Read a file from inside the workspace sandbox.',
  argsSchema: z.object({
    path: z.string().min(1),
    encoding: z.enum(['utf8', 'utf-8']).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('file-read', ctx);
    let target: string;
    try { target = resolveSafeWorkspacePath(args.path, ctx.workspaceRoot); }
    catch (err) { return { success: false, output: '', error: (err as Error).message }; }

    // H-2 fix: resolve symlinks before reading so a planted symlink
    // (workspace/link -> /etc/passwd) cannot escape the sandbox.
    // If the path does not exist, return a not-found result — NOT a security
    // error — so callers can distinguish "missing file" from "policy rejected".
    const root = path.resolve(ctx.workspaceRoot);
    const realRoot = await realpath(root).catch(() => root);
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'ENOENT') {
        return { success: false, output: '', error: `file-read: file not found: ${target}` };
      }
      return { success: false, output: '', error: e.message };
    }
    const rel = path.relative(realRoot, realTarget);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return {
        success: false,
        output: '',
        error: `file-read: path escapes workspace sandbox after symlink resolution (resolved=${realTarget}, root=${realRoot})`,
      };
    }

    try {
      const content = await readFile(realTarget, {
        encoding: (args.encoding ?? 'utf8') as BufferEncoding,
      });
      return { success: true, output: content };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, output: '', error: e.message };
    }
  },
});

registerTool({
  name: 'http-request',
  description: 'HTTP request to allowlisted hosts (default: localhost, api.telegram.org).',
  argsSchema: z.object({
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('http-request', ctx);
    if (!(await isHostAllowed(args.url))) {
      return {
        success: false,
        output: '',
        error: `http-request: URL not allowed: ${args.url}. Extend via HTTP_TOOL_ALLOWLIST env or src/v2/tools/core/index.ts.`,
      };
    }
    // EXEC-04: short-circuit if the workflow was cancelled before we open the socket.
    if (ctx.signal?.aborted) {
      return { success: false, output: '', error: 'http-request: cancelled before request' };
    }
    try {
      const res = await fetch(args.url, {
        method: args.method ?? 'GET',
        headers: args.headers,
        body: args.body,
        // EXEC-04: abort the in-flight HTTP request when the workflow is cancelled.
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const text = await res.text();
      return { success: res.ok, output: text, exitCode: res.status };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, output: '', error: e.message };
    }
  },
});

registerTool({
  name: 'current-time',
  description: 'Return the current ISO timestamp and an optional timezone-local rendering.',
  argsSchema: z.object({
    timezone: z.string().min(1).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('current-time', ctx);
    const now = new Date();
    const timezone = args.timezone ?? 'UTC';
    try {
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        dateStyle: 'short',
        timeStyle: 'medium',
        hour12: false,
      }).format(now);
      return {
        success: true,
        output: JSON.stringify({
          iso: now.toISOString(),
          timezone,
          local,
        }),
      };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return {
        success: false,
        output: '',
        error: `current-time: invalid timezone '${timezone}'${e.message ? ` (${e.message})` : ''}`,
      };
    }
  },
});

// 'calculator' and 'knowledge-search' tool registrations now live in
// calculator.ts and knowledge-search.ts respectively (side-effect imports
// at the top of this file).
