// Atomic patch application via `git apply`. Used by tool_call tasks to make
// surgical edits to existing files without the full reasoning round of cli_spawn.
//
// Flow: persist patch to tempfile → `git apply --check` → optionally `git apply`
// → on mid-apply failure, attempt `git apply --reverse` for rollback.
//
// Workspace boundary: all patch-affected paths must resolve under
// ctx.workspaceRoot. Paths that escape (via `..`, absolute, or symlink) are
// rejected before `--check` runs.

import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { registerTool, type ToolResult, type ToolContext } from '../registry.js';
import { pathEscapesWorkspace } from './sandbox-path.js';

export const ApplyPatchInputSchema = z.object({
  patch: z.string().min(1).describe('Unified diff (git-style) to apply'),
  dryRun: z.boolean().default(false).describe('When true, run --check only and report intended changes'),
});

export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export interface ApplyPatchOutput {
  applied: boolean;
  filesChanged: string[];
  rejected: string[];
  message: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('error', (err) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err) });
    });
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

// Extract a/<path> and b/<path> from `diff --git` headers, plus +++ b/<path>
// from raw unified diffs (no git header). De-dupes the result.
export function parsePatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split('\n');
  for (const line of lines) {
    const gitMatch = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
    if (gitMatch) {
      paths.add(gitMatch[1]);
      paths.add(gitMatch[2]);
      continue;
    }
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch && plusMatch[1] !== '/dev/null') {
      paths.add(plusMatch[1]);
      continue;
    }
    const minusMatch = /^--- a\/(.+)$/.exec(line);
    if (minusMatch && minusMatch[1] !== '/dev/null') {
      paths.add(minusMatch[1]);
    }
  }
  return [...paths];
}

export async function applyPatch(
  input: ApplyPatchInput,
  ctx: ToolContext,
): Promise<ApplyPatchOutput> {
  const filesChanged = parsePatchPaths(input.patch);

  // Reject any path that escapes the workspace before we touch git.
  for (const p of filesChanged) {
    if (pathEscapesWorkspace(p, ctx.workspaceRoot)) {
      return {
        applied: false,
        filesChanged: [],
        rejected: filesChanged,
        message: `Patch affects path outside workspace: ${p}`,
      };
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'omniforge-apply-patch-'));
  const patchFile = join(dir, 'patch.diff');

  try {
    await writeFile(patchFile, input.patch, 'utf-8');

    const check = await runGit(['apply', '--check', patchFile], ctx.workspaceRoot);
    if (check.exitCode !== 0) {
      return {
        applied: false,
        filesChanged,
        rejected: filesChanged,
        message: `git apply --check failed (exit ${check.exitCode}): ${check.stderr.trim()}`,
      };
    }

    if (input.dryRun) {
      return {
        applied: false,
        filesChanged,
        rejected: [],
        message: 'dry-run ok',
      };
    }

    const apply = await runGit(['apply', patchFile], ctx.workspaceRoot);
    if (apply.exitCode !== 0) {
      // Best-effort rollback if any hunks landed before failure.
      await runGit(['apply', '--reverse', patchFile], ctx.workspaceRoot);
      return {
        applied: false,
        filesChanged,
        rejected: filesChanged,
        message: `git apply failed mid-run, rollback attempted (exit ${apply.exitCode}): ${apply.stderr.trim()}`,
      };
    }

    return {
      applied: true,
      filesChanged,
      rejected: [],
      message: 'ok',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* tempdir cleanup best-effort */ });
  }
}

registerTool({
  name: 'apply-patch',
  description: 'Apply unified diff to workspace via git apply, with rollback on mid-apply failure',
  argsSchema: ApplyPatchInputSchema,
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const out = await applyPatch(args, ctx);
      return {
        success: out.applied,
        output: JSON.stringify(out),
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
