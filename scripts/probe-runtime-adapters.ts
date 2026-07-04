import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listRuntimeExecutorCapabilities,
  type RuntimeProtocolCapability,
} from '../src/runtime/capabilities.js';
import { redactRuntimeValue } from '../src/runtime/events.js';

interface ProbeOptions {
  dryRun: boolean;
  executorId?: string;
  outDir?: string;
  timeoutMs: number;
}

interface RuntimeAdapterProbeReport {
  executorId: string;
  displayName: string;
  command: string;
  version?: string;
  protocolAttempted: string;
  streamFormat: string;
  statusBeforeProbe: string;
  started: boolean;
  sessionIdFound: boolean;
  streamEventsObserved: number;
  toolEventsObserved: number;
  permissionRequestsObserved: number;
  finalResultObserved: boolean;
  fallbackUsed: boolean;
  dryRun: boolean;
  artifactPath?: string;
  structuredError?: {
    code: string;
    origin: string;
    message: string;
    suggestedAction: string;
    safeContext?: Record<string, unknown>;
  };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMMAND_BY_EXECUTOR: Record<string, string> = {
  'cli:claude-code': 'claude',
  'cli:codex': 'codex',
  'cli:gemini': 'gemini',
  'cli:kimi': 'kimi',
  'cli:opencode': 'opencode',
  'cli:cursor': 'cursor',
};

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = { dryRun: true, timeoutMs: 8_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live') options.dryRun = false;
    if (arg === '--dry-run') options.dryRun = true;
    if (arg === '--executor') options.executorId = argv[++i];
    if (arg === '--out') options.outDir = argv[++i];
    if (arg === '--timeout-ms') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = parsed;
    }
  }
  return options;
}

function safeReportValue<T>(value: T): T {
  return redactRuntimeValue(value) as T;
}

function versionArgsFor(command: string): string[] {
  if (command === 'claude') return ['--version'];
  if (command === 'codex') return ['--version'];
  if (command === 'gemini') return ['--version'];
  if (command === 'kimi') return ['--version'];
  if (command === 'opencode') return ['--version'];
  if (command === 'cursor') return ['--version'];
  return ['--version'];
}

function structuredError(
  code: string,
  message: string,
  suggestedAction: string,
  safeContext?: Record<string, unknown>,
): RuntimeAdapterProbeReport['structuredError'] {
  return {
    code,
    origin: 'runtime-adapter-probe',
    message,
    suggestedAction,
    safeContext: safeContext ? safeReportValue(safeContext) : undefined,
  };
}

async function runVersionProbe(command: string, timeoutMs: number): Promise<{ started: boolean; version?: string; error?: RuntimeAdapterProbeReport['structuredError'] }> {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, versionArgsFor(command), {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      resolve({
        started: true,
        error: structuredError(
          'runtime_probe_timeout',
          `Version probe for ${command} timed out after ${timeoutMs}ms.`,
          'Run the probe again with --timeout-ms after verifying the CLI is responsive.',
          { command, timeoutMs },
        ),
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        started: false,
        error: structuredError(
          'runtime_probe_spawn_failed',
          err.message,
          'Install the CLI or verify it is on PATH before enabling this adapter.',
          { command, code: err.code ?? 'unknown' },
        ),
      });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.trim();
      if (code !== 0) {
        resolve({
          started: true,
          version: safeReportValue(combined.slice(0, 500)),
          error: structuredError(
            'runtime_probe_nonzero_exit',
            `${command} --version exited with code ${code}.`,
            'Inspect the CLI installation before marking this adapter verified.',
            { command, exitCode: code, outputPreview: combined.slice(0, 500) },
          ),
        });
        return;
      }
      resolve({
        started: true,
        version: safeReportValue(combined.split(/\r?\n/)[0]?.slice(0, 500) ?? ''),
      });
    });
  });
}

function reportForDryRun(
  executorId: string,
  displayName: string,
  command: string,
  protocol: RuntimeProtocolCapability,
): RuntimeAdapterProbeReport {
  return {
    executorId,
    displayName,
    command,
    protocolAttempted: protocol.tier,
    streamFormat: protocol.streamFormat,
    statusBeforeProbe: protocol.status,
    started: false,
    sessionIdFound: false,
    streamEventsObserved: 0,
    toolEventsObserved: 0,
    permissionRequestsObserved: 0,
    finalResultObserved: false,
    fallbackUsed: protocol.tier === 'text-pty-fallback',
    dryRun: true,
    structuredError: structuredError(
      'runtime_probe_dry_run',
      'Probe harness generated a dry-run report without starting a CLI process.',
      'Run with --live only when no user workflow depends on the current daemon and the CLI can be probed safely.',
      { executorId, protocol: protocol.tier, status: protocol.status },
    ),
  };
}

async function reportForLiveVersionProbe(
  executorId: string,
  displayName: string,
  command: string,
  protocol: RuntimeProtocolCapability,
  timeoutMs: number,
): Promise<RuntimeAdapterProbeReport> {
  const version = await runVersionProbe(command, timeoutMs);
  return {
    executorId,
    displayName,
    command,
    version: version.version,
    protocolAttempted: protocol.tier,
    streamFormat: protocol.streamFormat,
    statusBeforeProbe: protocol.status,
    started: version.started,
    sessionIdFound: false,
    streamEventsObserved: 0,
    toolEventsObserved: 0,
    permissionRequestsObserved: 0,
    finalResultObserved: false,
    fallbackUsed: protocol.tier === 'text-pty-fallback',
    dryRun: false,
    structuredError: version.error ?? (
      protocol.tier === 'acp-stdio' || protocol.tier === 'app-server-jsonrpc'
        ? structuredError(
          'runtime_protocol_probe_not_attempted',
          `${protocol.tier} requires a dedicated JSON-RPC handshake probe; this live pass only verified process startup/version.`,
          'Keep this adapter planned/experimental until a protocol turn observes JSON-RPC events and session ids.',
          { executorId, protocol: protocol.tier, command },
        )
        : undefined
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(options.outDir ?? path.join(repoRoot, '_artifacts', 'runtime-adapter-probes', timestamp));
  mkdirSync(outDir, { recursive: true });

  const capabilities = listRuntimeExecutorCapabilities()
    .filter((capability) => !options.executorId || capability.executorId === options.executorId);
  if (capabilities.length === 0) {
    throw new Error(`No runtime capability matched executor: ${options.executorId ?? '(none)'}`);
  }

  const reports: RuntimeAdapterProbeReport[] = [];
  for (const capability of capabilities) {
    const command = COMMAND_BY_EXECUTOR[capability.executorId] ?? capability.executorId.replace(/^cli:/, '');
    for (const protocol of capability.protocols) {
      const report = options.dryRun
        ? reportForDryRun(capability.executorId, capability.displayName, command, protocol)
        : await reportForLiveVersionProbe(capability.executorId, capability.displayName, command, protocol, options.timeoutMs);
      const filename = `${capability.executorId.replace(/[:/]/g, '-')}-${protocol.tier}.json`;
      const artifactPath = path.join(outDir, filename);
      report.artifactPath = artifactPath;
      writeFileSync(artifactPath, `${JSON.stringify(safeReportValue(report), null, 2)}\n`, 'utf8');
      reports.push(report);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    reportDir: outDir,
    reportCount: reports.length,
    reports: reports.map((report) => ({
      executorId: report.executorId,
      protocolAttempted: report.protocolAttempted,
      streamFormat: report.streamFormat,
      statusBeforeProbe: report.statusBeforeProbe,
      started: report.started,
      fallbackUsed: report.fallbackUsed,
      errorCode: report.structuredError?.code ?? null,
      artifactPath: report.artifactPath,
    })),
  };
  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(safeReportValue(summary), null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(safeReportValue(summary), null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
