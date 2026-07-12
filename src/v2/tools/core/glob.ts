import { glob as nodeGlob } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { registerTool, type ToolResult, type ToolContext } from '../registry.js';
import { resolveSafeWorkspacePath } from './sandbox-path.js';

export const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  ignore: z.array(z.string()).optional(),
  maxResults: z.number().int().positive().max(10000).default(1000),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

export interface GlobOutput {
  matches: string[];
  truncated: boolean;
}

const DEFAULT_IGNORE = ['node_modules/**', 'dist/**', '.git/**', 'data/**'];

/**
 * Extract the leading directory segment from a glob pattern like 'node_modules/**'
 * so we can use it for fast prefix exclusion.
 */
function extractIgnoreSegments(patterns: string[]): string[] {
  return patterns.map((p) => {
    const stripped = p.replace(/[*?{}.]/g, '').replace(/\/+$/, '').replace(/^\//, '');
    return stripped.split('/')[0] ?? '';
  }).filter(Boolean);
}

export async function glob(input: GlobInput, ctx: ToolContext): Promise<GlobOutput> {
  const searchRoot = input.path
    ? resolveSafeWorkspacePath(input.path, ctx.workspaceRoot)
    : path.resolve(ctx.workspaceRoot);

  const ignorePatterns = input.ignore ?? DEFAULT_IGNORE;
  const ignoreSegments = extractIgnoreSegments(ignorePatterns);
  const maxResults = input.maxResults;

  // The exclude callback receives a relative path string from cwd
  const excludeFn = (entryPath: string): boolean => {
    const parts = entryPath.replace(/\\/g, '/').split('/');
    return parts.some((part) => ignoreSegments.includes(part));
  };

  const iter = nodeGlob(input.pattern, {
    cwd: searchRoot,
    exclude: excludeFn,
    withFileTypes: false,
  });

  const matches: string[] = [];
  let truncated = false;

  for await (const match of iter) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    // matches are already relative to searchRoot
    matches.push((match as string).replace(/\\/g, '/'));
  }

  return { matches, truncated };
}

registerTool({
  name: 'glob',
  description: 'Find files matching a glob pattern inside the workspace sandbox.',
  argsSchema: GlobInputSchema,
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const result = await glob(args, ctx);
      return {
        success: true,
        output: JSON.stringify(result),
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: (err as Error).message,
      };
    }
  },
});
