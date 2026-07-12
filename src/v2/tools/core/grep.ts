import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { registerTool, type ToolResult, type ToolContext } from '../registry.js';
import { resolveSafeWorkspacePath } from './sandbox-path.js';

// ───────────────────────────────────────────────────────────────────────
// Schema & types
// ───────────────────────────────────────────────────────────────────────

export const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  filePattern: z.string().optional(),
  caseSensitive: z.boolean().default(false),
  contextLines: z.number().int().nonnegative().max(20).default(0),
  maxResults: z.number().int().positive().max(5000).default(500),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  context?: { before: string[]; after: string[] };
}

export interface GrepOutput {
  matches: GrepMatch[];
  truncated: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Default exclusions
// ───────────────────────────────────────────────────────────────────────

const DEFAULT_EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'data']);

// ───────────────────────────────────────────────────────────────────────
// ripgrep-based implementation (always uses --json for robust path parsing)
// ───────────────────────────────────────────────────────────────────────

function spawnAsync(cmd: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code: code ?? 0,
      });
    });
    proc.on('error', (err) => resolve({ stdout: '', stderr: String(err), code: 1 }));
  });
}

async function rgAvailable(): Promise<boolean> {
  const result = await spawnAsync('rg', ['--version'], process.cwd());
  return result.code === 0;
}

interface RgJsonMatch {
  type: 'match' | 'context' | 'begin' | 'end' | 'summary';
  data: {
    path?: { text: string };
    line_number?: number;
    lines?: { text: string };
    submatches?: unknown[];
  };
}

/** Parse rg's newline-delimited JSON messages, silently dropping unparseable lines. */
function parseRgJsonMessages(stdout: string): RgJsonMatch[] {
  const messages: RgJsonMatch[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    try {
      messages.push(JSON.parse(line) as RgJsonMatch);
    } catch {
      continue;
    }
  }
  return messages;
}

/**
 * Look ahead from a 'match' message at `matchIndex` and collect up to
 * `contextLines` subsequent 'context' lines for the same file, stopping at
 * the next 'match' message or a file boundary.
 */
function collectAfterContext(
  messages: RgJsonMatch[],
  matchIndex: number,
  file: string,
  contextLines: number,
): string[] {
  const after: string[] = [];
  for (let j = matchIndex + 1; j < messages.length && after.length < contextLines; j++) {
    const next = messages[j];
    if (!next) break;
    if (next.type === 'context' && next.data.path?.text === file) {
      after.push((next.data.lines?.text ?? '').replace(/\n$/, ''));
    } else if (next.type === 'match') {
      break;
    }
  }
  return after;
}

function parseRgJsonOutput(
  stdout: string,
  searchRoot: string,
  contextLines: number,
  maxResults: number,
): { matches: GrepMatch[]; truncated: boolean } {
  const matches: GrepMatch[] = [];
  let truncated = false;

  const messages = parseRgJsonMessages(stdout);

  // Build matches with context by scanning messages
  const contextBefore: string[] = [];
  let lastFile = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.type === 'context') {
      const file = msg.data.path?.text ?? '';
      if (file !== lastFile) {
        contextBefore.length = 0;
        lastFile = file;
      }
      const text = (msg.data.lines?.text ?? '').replace(/\n$/, '');
      if (contextLines > 0) {
        contextBefore.push(text);
        if (contextBefore.length > contextLines) contextBefore.shift();
      }
    } else if (msg.type === 'match') {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      const file = msg.data.path?.text ?? '';
      if (file !== lastFile) {
        contextBefore.length = 0;
        lastFile = file;
      }
      const relFile = path.relative(searchRoot, file).replace(/\\/g, '/');
      const matchText = (msg.data.lines?.text ?? '').replace(/\n$/, '');

      const match: GrepMatch = {
        file: relFile,
        line: msg.data.line_number ?? 0,
        text: matchText,
      };

      if (contextLines > 0) {
        match.context = {
          before: [...contextBefore],
          after: collectAfterContext(messages, i, file, contextLines),
        };
      }

      matches.push(match);
      contextBefore.length = 0;
    }
  }

  return { matches, truncated };
}

async function grepWithRg(input: GrepInput, searchRoot: string): Promise<GrepOutput> {
  const args: string[] = ['--json', '--line-number'];
  if (!input.caseSensitive) args.push('--ignore-case');
  for (const d of DEFAULT_EXCLUDED_DIRS) args.push('--glob', `!${d}/**`);
  if (input.filePattern) args.push('--glob', input.filePattern);
  if (input.contextLines > 0) args.push('--context', String(input.contextLines));
  args.push(input.pattern, searchRoot);

  const result = await spawnAsync('rg', args, searchRoot);
  // exit code 1 = no matches (not an error), 2 = error
  if (result.code === 2) {
    throw new Error(`rg error: ${result.stderr}`);
  }

  return parseRgJsonOutput(result.stdout, searchRoot, input.contextLines, input.maxResults);
}

// ───────────────────────────────────────────────────────────────────────
// Node.js fallback grep
// ───────────────────────────────────────────────────────────────────────

async function grepWithNode(input: GrepInput, searchRoot: string): Promise<GrepOutput> {
  const flags = input.caseSensitive ? '' : 'i';
  const regex = new RegExp(input.pattern, flags);
  const fileRegex = input.filePattern
    ? new RegExp(input.filePattern.replace(/\*/g, '.*').replace(/\?/g, '.'))
    : null;

  const matches: GrepMatch[] = [];
  let truncated = false;

  async function visit(dir: string): Promise<void> {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.has(entry.name)) await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (fileRegex && !fileRegex.test(entry.name)) continue;

      const info = await stat(full).catch(() => null);
      if (!info || info.size > 1024 * 1024 * 10) continue;

      const content = await readFile(full, 'utf8').catch(() => null);
      if (!content) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= input.maxResults) { truncated = true; return; }
        if (regex.test(lines[i]!)) {
          const match: GrepMatch = {
            file: path.relative(searchRoot, full).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i]!,
          };
          if (input.contextLines > 0) {
            match.context = {
              before: lines.slice(Math.max(0, i - input.contextLines), i),
              after: lines.slice(i + 1, i + 1 + input.contextLines),
            };
          }
          matches.push(match);
        }
      }
    }
  }

  await visit(searchRoot);
  return { matches, truncated };
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

export async function grep(input: GrepInput, ctx: ToolContext): Promise<GrepOutput> {
  const searchRoot = input.path
    ? resolveSafeWorkspacePath(input.path, ctx.workspaceRoot)
    : path.resolve(ctx.workspaceRoot);

  const useRg = await rgAvailable().catch(() => false);
  return useRg ? grepWithRg(input, searchRoot) : grepWithNode(input, searchRoot);
}

// ───────────────────────────────────────────────────────────────────────
// Tool registration
// ───────────────────────────────────────────────────────────────────────

registerTool({
  name: 'grep',
  description: 'Search file contents with regex inside the workspace sandbox (uses rg when available).',
  argsSchema: GrepInputSchema,
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const result = await grep(args, ctx);
      return { success: true, output: JSON.stringify(result) };
    } catch (err: unknown) {
      return { success: false, output: '', error: (err as Error).message };
    }
  },
});
