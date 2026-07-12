// Local-workspace knowledge search: naive TF + path-boost scoring over text
// files in the sandbox, with secret scrubbing before content is ever
// returned. Extracted from tools/core/index.ts — see calculator.ts for the
// same sibling-module rationale.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { registerTool, type ToolResult } from '../registry.js';
import { resolveSafeWorkspacePath } from './sandbox-path.js';
import { assertToolEnabled } from './tool-policy.js';

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
      searchRoot = args.root ? resolveSafeWorkspacePath(args.root, ctx.workspaceRoot) : path.resolve(ctx.workspaceRoot);
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
