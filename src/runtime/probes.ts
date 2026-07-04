import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { redactRuntimeValue } from './events.js';

export interface RuntimeProbeRunInput {
  dryRun?: boolean;
  live?: boolean;
  confirmLive?: boolean;
  executorId?: string;
  timeoutMs?: number;
  outDir?: string;
  repoRoot?: string;
}

export interface RuntimeProbeSummary {
  generatedAt?: string;
  dryRun: boolean;
  reportDir: string;
  reportCount: number;
  reports: Array<Record<string, unknown>>;
}

export interface RuntimeProbeRunResult {
  ok: boolean;
  summary: RuntimeProbeSummary | null;
  stdout: string;
  stderr: string;
  structured_error?: {
    code: string;
    origin: string;
    message: string;
    suggestedAction: string;
    safeContext?: Record<string, unknown>;
  };
}

function structuredError(
  code: string,
  message: string,
  suggestedAction: string,
  safeContext?: Record<string, unknown>,
): RuntimeProbeRunResult['structured_error'] {
  return {
    code,
    origin: 'runtime.probes',
    message,
    suggestedAction,
    safeContext: safeContext ? redactRuntimeValue(safeContext) as Record<string, unknown> : undefined,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toSummary(raw: Record<string, unknown>): RuntimeProbeSummary {
  return {
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : undefined,
    dryRun: Boolean(raw.dryRun),
    reportDir: String(raw.reportDir ?? ''),
    reportCount: Number(raw.reportCount ?? 0),
    reports: Array.isArray(raw.reports)
      ? raw.reports.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
      )
      : [],
  };
}

export function latestRuntimeProbeSummary(repoRoot = process.cwd()): RuntimeProbeSummary | null {
  const root = path.join(repoRoot, '_artifacts', 'runtime-adapter-probes');
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs.reverse()) {
    const summaryPath = path.join(root, dir, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    const parsed = parseJsonObject(readFileSync(summaryPath, 'utf8'));
    if (parsed) return toSummary(redactRuntimeValue(parsed) as Record<string, unknown>);
  }
  return null;
}

export async function runRuntimeAdapterProbe(input: RuntimeProbeRunInput = {}): Promise<RuntimeProbeRunResult> {
  const live = input.live === true || input.dryRun === false;
  if (live && input.confirmLive !== true) {
    return {
      ok: false,
      summary: null,
      stdout: '',
      stderr: '',
      structured_error: structuredError(
        'runtime_probe_live_confirmation_required',
        'Live runtime probe was requested without explicit confirmation.',
        'Run dry-run first, then pass confirm_live=true only when it is safe to start local CLI processes.',
        { executorId: input.executorId ?? null },
      ),
    };
  }

  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const pnpmArgs = ['exec', 'tsx', 'scripts/probe-runtime-adapters.ts', live ? '--live' : '--dry-run'];
  if (input.executorId) pnpmArgs.push('--executor', input.executorId);
  if (input.timeoutMs) pnpmArgs.push('--timeout-ms', String(input.timeoutMs));
  if (input.outDir) pnpmArgs.push('--out', input.outDir);
  const command = process.platform === 'win32' ? 'cmd' : 'pnpm';
  const args = process.platform === 'win32' ? ['/c', 'pnpm', ...pnpmArgs] : pnpmArgs;

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (err) => {
      resolve({
        ok: false,
        summary: null,
        stdout: redactRuntimeValue(stdout) as string,
        stderr: redactRuntimeValue(stderr) as string,
        structured_error: structuredError(
          'runtime_probe_spawn_failed',
          err.message,
          'Verify pnpm/tsx are available in the Omniforge Aurora checkout before running probes from the dashboard.',
          { repoRoot, executorId: input.executorId ?? null },
        ),
      });
    });
    child.once('close', (code) => {
      const parsed = parseJsonObject(stdout.trim());
      const summary = parsed ? toSummary(redactRuntimeValue(parsed) as Record<string, unknown>) : latestRuntimeProbeSummary(repoRoot);
      resolve({
        ok: code === 0,
        summary,
        stdout: redactRuntimeValue(stdout) as string,
        stderr: redactRuntimeValue(stderr) as string,
        ...(code === 0
          ? {}
          : {
              structured_error: structuredError(
                'runtime_probe_failed',
                `Runtime adapter probe exited with code ${code ?? 'unknown'}.`,
                'Open the probe stderr and generated artifact directory before enabling any adapter.',
                { exitCode: code, executorId: input.executorId ?? null },
              ),
            }),
      });
    });
  });
}
