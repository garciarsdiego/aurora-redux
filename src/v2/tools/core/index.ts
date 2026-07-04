import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { registerTool, setExternalMcpRouter, type ToolResult, type ToolContext } from '../registry.js';
import { initDb } from '../../../db/client.js';
import { insertEvent } from '../../../db/persist.js';
import { getDbPath } from '../../../utils/config.js';
import { ExternalMcpManager } from '../../external-mcp/client.js';
import { parsePrefixedToolName } from '../../external-mcp/types.js';
import type { ExternalMcpCallResult } from '../../external-mcp/types.js';

// Side-effect imports: each module registers its tool at top level.
import './web-fetch.js';
import './web-search.js';
import './glob.js';
import './grep.js';
import './apply-patch.js';

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
 * `assertToolEnabled` above) because `ToolContext` does not carry a DB
 * handle — the context is workspace-scoped, not DB-scoped.
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
    // Emit error audit event — best-effort (must not mask original throw).
    try {
      const db = initDb(getDbPath());
      try {
        insertEvent(db, {
          workflow_id: ctx.workflowId,
          type: 'external_mcp_tool_error',
          payload: {
            tool: prefixedName,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        db.close();
      }
    } catch {
      // Telemetry must not mask the original error.
    }
    throw err;
  }

  // Emit success/isError audit event — best-effort.
  try {
    const db = initDb(getDbPath());
    try {
      insertEvent(db, {
        workflow_id: ctx.workflowId,
        type: 'external_mcp_tool_called',
        payload: {
          tool: prefixedName,
          is_error: result.isError,
        },
      });
    } finally {
      db.close();
    }
  } catch {
    // Telemetry must not mask the tool result.
  }

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

/**
 * Error type thrown when a tool is disabled by the workspace_tool_overrides
 * policy. Distinguished from generic errors so the executor can route this
 * as a non-retryable failure rather than treating it as a transient bug.
 */
export class ToolDisabledError extends Error {
  readonly toolId: string;
  readonly workspace: string;
  constructor(toolId: string, workspace: string) {
    super(`tool '${toolId}' is disabled for workspace '${workspace}' by Setup → Tools policy`);
    this.name = 'ToolDisabledError';
    this.toolId = toolId;
    this.workspace = workspace;
  }
}

/**
 * Consult the workspace_tool_overrides table for the given (workspace, toolId)
 * pair. Empty row → enabled (default-ON preserves behaviour for fresh installs
 * and pre-Wave-2 deployments). enabled=0 → disabled.
 *
 * The DB handle is opened fresh per call because the static tool registry
 * doesn't have access to the executor's DB. Single-operator workloads run a
 * few tool calls per workflow so the open/close cost is negligible compared
 * to the cost of the tool itself.
 */
function isToolEnabledForWorkspace(toolId: string, workspace: string): boolean {
  try {
    const db = initDb(getDbPath());
    try {
      const row = db
        .prepare(
          `SELECT enabled FROM workspace_tool_overrides
           WHERE workspace = ? AND tool_id = ?`,
        )
        .get(workspace, toolId) as { enabled: number } | undefined;
      // Absent row → default enabled.
      return row === undefined || row.enabled === 1;
    } finally {
      db.close();
    }
  } catch {
    // DB unavailable → fail OPEN so the executor doesn't grind to a halt
    // because of an unrelated DB outage. The setup-config persistence
    // failure mode is already non-blocking.
    return true;
  }
}

/**
 * Emit a `tool_disabled_by_policy` event when a tool is refused by the
 * workspace policy. Best-effort: failures to write the event must not mask
 * the original ToolDisabledError that the caller will throw.
 */
function recordToolDisabledEvent(toolId: string, ctx: ToolContext): void {
  try {
    const db = initDb(getDbPath());
    try {
      insertEvent(db, {
        workflow_id: ctx.workflowId,
        type: 'tool_disabled_by_policy',
        payload: {
          tool_id: toolId,
          workspace: ctx.workspace,
        },
      });
    } finally {
      db.close();
    }
  } catch {
    // Telemetry must not mask the policy decision.
  }
}

/**
 * Guard called at the start of every core-tool `execute()`. Throws
 * `ToolDisabledError` when the operator has disabled the tool for the
 * active workspace via the Setup → Tools pane.
 */
function assertToolEnabled(toolId: string, ctx: ToolContext): void {
  if (isToolEnabledForWorkspace(toolId, ctx.workspace)) return;
  recordToolDisabledEvent(toolId, ctx);
  throw new ToolDisabledError(toolId, ctx.workspace);
}

// ───────────────────────────────────────────────────────────────────────
// Sandbox helpers
// ───────────────────────────────────────────────────────────────────────

// Resolve an LLM-supplied path against the workspace root and ensure the
// resolved location stays inside the sandbox. Absolute paths are accepted
// only when they already lie under workspaceRoot.
function resolveSafeWorkspacePath(rawPath: string, ctx: ToolContext): string {
  const root = path.resolve(ctx.workspaceRoot);
  const candidate = path.isAbsolute(rawPath) || /^[A-Za-z]:[/\\]/.test(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(root, rawPath);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace sandbox: ${rawPath} (resolved=${candidate}, root=${root})`);
  }
  return candidate;
}

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
const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd)/i;

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_RE.test(hostname);
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

const KNOWLEDGE_EXCLUDED_DIRS = new Set([
  '.git',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'vendor',
  'venv',
]);

const KNOWLEDGE_TEXT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.md',
  '.py',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const KNOWLEDGE_MAX_FILES = 200;
const KNOWLEDGE_MAX_BYTES = 256 * 1024;
const KNOWLEDGE_CHUNK_SIZE = 1_200;
const KNOWLEDGE_CHUNK_OVERLAP = 160;

const KNOWLEDGE_SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /(ghp|github_pat)_[A-Za-z0-9_]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['"]?)[^'"\s,;}]{8,}/gi,
];

function isKnowledgeTextFile(filePath: string): boolean {
  return KNOWLEDGE_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function scrubKnowledgeSecrets(content: string): string {
  return KNOWLEDGE_SECRET_PATTERNS.reduce((acc, pattern) => {
    if (pattern.source.startsWith('((?:api')) {
      return acc.replace(pattern, '$1[REDACTED]');
    }
    if (pattern.source.startsWith('(Bearer')) {
      return acc.replace(pattern, '$1[REDACTED]');
    }
    return acc.replace(pattern, '[REDACTED]');
  }, content);
}

function tokenizeKnowledgeQuery(query: string): string[] {
  const stopwords = new Set(['and', 'com', 'das', 'dos', 'for', 'para', 'que', 'the', 'uma', 'with']);
  return Array.from(new Set(
    query
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9_/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !stopwords.has(token)),
  ));
}

function chunkKnowledgeContent(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += KNOWLEDGE_CHUNK_SIZE - KNOWLEDGE_CHUNK_OVERLAP) {
    const rawChunk = normalized.slice(start, start + KNOWLEDGE_CHUNK_SIZE);
    chunks.push(rawChunk.trim());
    if (start + KNOWLEDGE_CHUNK_SIZE >= normalized.length) break;
  }
  return chunks.filter(Boolean);
}

async function collectKnowledgeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (files.length >= KNOWLEDGE_MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= KNOWLEDGE_MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!KNOWLEDGE_EXCLUDED_DIRS.has(entry.name)) {
          await visit(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || !isKnowledgeTextFile(entryPath)) continue;
      const info = await stat(entryPath);
      if (info.size <= KNOWLEDGE_MAX_BYTES) {
        files.push(entryPath);
      }
    }
  }
  await visit(root);
  return files;
}

function scoreKnowledgeChunk(relativePath: string, content: string, tokens: string[]): number {
  const haystack = `${relativePath}\n${content}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return tokens.reduce((score, token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = haystack.match(new RegExp(escaped, 'g'))?.length ?? 0;
    const pathBoost = relativePath.toLowerCase().includes(token) ? 3 : 0;
    return score + count + pathBoost;
  }, 0);
}

class CalculatorParser {
  private cursor = 0;

  constructor(private readonly source: string) {}

  parse(): number {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.cursor !== this.source.length) {
      throw new Error(`calculator: unexpected token at ${this.cursor}`);
    }
    if (!Number.isFinite(value)) throw new Error('calculator: result is not finite');
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
  }

  private match(char: string): boolean {
    this.skipWhitespace();
    if (this.source[this.cursor] !== char) return false;
    this.cursor += 1;
    return true;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      if (this.match('+')) value += this.parseTerm();
      else if (this.match('-')) value -= this.parseTerm();
      else return value;
    }
  }

  private parseTerm(): number {
    let value = this.parsePower();
    while (true) {
      if (this.match('*')) value *= this.parsePower();
      else if (this.match('/')) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error('calculator: division by zero');
        value /= divisor;
      } else if (this.match('%')) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error('calculator: modulo by zero');
        value %= divisor;
      } else return value;
    }
  }

  private parsePower(): number {
    const left = this.parseUnary();
    if (!this.match('^')) return left;
    return left ** this.parsePower();
  }

  private parseUnary(): number {
    if (this.match('+')) return this.parseUnary();
    if (this.match('-')) return -this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    if (this.match('(')) {
      const value = this.parseExpression();
      if (!this.match(')')) throw new Error('calculator: missing closing parenthesis');
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.cursor;
    if (this.source[this.cursor] === '.') this.cursor += 1;
    while (/\d/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
    if (this.source[this.cursor] === '.') {
      this.cursor += 1;
      while (/\d/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
    }
    if (this.source[this.cursor] === 'e' || this.source[this.cursor] === 'E') {
      this.cursor += 1;
      if (this.source[this.cursor] === '+' || this.source[this.cursor] === '-') this.cursor += 1;
      while (/\d/.test(this.source[this.cursor] ?? '')) this.cursor += 1;
    }
    const raw = this.source.slice(start, this.cursor);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) {
      throw new Error(`calculator: expected number at ${start}`);
    }
    return Number(raw);
  }
}

function evaluateCalculatorExpression(expression: string): number {
  if (!/^[\d\s+\-*/%^().eE]+$/.test(expression)) {
    throw new Error('calculator: expression may only contain numbers, operators and parentheses');
  }
  return new CalculatorParser(expression).parse();
}

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
      cwd = args.cwd ? resolveSafeWorkspacePath(args.cwd, ctx) : path.resolve(ctx.workspaceRoot);
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
    try { target = resolveSafeWorkspacePath(args.path, ctx); }
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
    try { target = resolveSafeWorkspacePath(args.path, ctx); }
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

registerTool({
  name: 'calculator',
  description: 'Evaluate a deterministic arithmetic expression without eval.',
  argsSchema: z.object({
    expression: z.string().min(1).max(500),
    precision: z.number().int().min(0).max(12).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('calculator', ctx);
    try {
      const result = evaluateCalculatorExpression(args.expression);
      const output = typeof args.precision === 'number'
        ? Number(result.toFixed(args.precision))
        : result;
      return {
        success: true,
        output: JSON.stringify({
          expression: args.expression,
          result: output,
        }),
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

registerTool({
  name: 'knowledge-search',
  description: 'Search local text knowledge inside the workflow workspace sandbox with secret scrubbing.',
  argsSchema: z.object({
    query: z.string().min(2),
    top_k: z.number().int().min(1).max(10).optional(),
    root: z.string().min(1).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    assertToolEnabled('knowledge-search', ctx);
    const tokens = tokenizeKnowledgeQuery(args.query);
    if (tokens.length === 0) {
      return {
        success: false,
        output: '',
        error: 'knowledge-search: query needs at least one searchable token with 3+ characters',
      };
    }

    let searchRoot: string;
    try {
      searchRoot = args.root ? resolveSafeWorkspacePath(args.root, ctx) : path.resolve(ctx.workspaceRoot);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }

    try {
      const files = await collectKnowledgeFiles(searchRoot);
      const matches: Array<{
        relativePath: string;
        chunkIndex: number;
        score: number;
        content: string;
      }> = [];

      for (const filePath of files) {
        const relativePath = path.relative(ctx.workspaceRoot, filePath).replace(/\\/g, '/');
        const raw = await readFile(filePath, 'utf8');
        const scrubbed = scrubKnowledgeSecrets(raw);
        const chunks = chunkKnowledgeContent(scrubbed);
        chunks.forEach((chunk, chunkIndex) => {
          const score = scoreKnowledgeChunk(relativePath, chunk, tokens);
          if (score > 0) {
            matches.push({
              relativePath,
              chunkIndex,
              score,
              content: chunk,
            });
          }
        });
      }

      const topK = args.top_k ?? 5;
      const topMatches = matches
        .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
        .slice(0, topK);

      if (topMatches.length === 0) {
        return {
          success: true,
          output: `No local knowledge matches found for query: ${args.query}`,
        };
      }

      return {
        success: true,
        output: topMatches.map((match) => {
          const preview = match.content.length > 1_200
            ? `${match.content.slice(0, 1_200)}\n[truncated]`
            : match.content;
          return `[Document: ${match.relativePath}, chunk ${match.chunkIndex + 1}, score ${match.score}]\n${preview}`;
        }).join('\n\n---\n\n'),
      };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, output: '', error: `knowledge-search: ${e.message ?? 'failed to search local knowledge'}` };
    }
  },
});
