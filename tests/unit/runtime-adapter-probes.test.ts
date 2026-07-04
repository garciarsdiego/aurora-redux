import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { listRuntimeExecutorCapabilities } from '../../src/runtime/capabilities.js';
import { parseAcpJsonRpcLine, unsupportedAcpAdapter } from '../../src/runtime/adapters/acp.js';
import { parseJsonlRuntimeOutput } from '../../src/runtime/adapters/jsonl.js';
import { decideServerJsonRpcProbe } from '../../src/runtime/adapters/server-jsonrpc.js';

interface ProbeSummary {
  dryRun: boolean;
  reportDir: string;
  reportCount: number;
  reports: Array<{
    executorId: string;
    protocolAttempted: string;
    statusBeforeProbe: string;
    started: boolean;
    fallbackUsed: boolean;
    errorCode: string | null;
    artifactPath: string;
  }>;
}

interface ProbeReport {
  executorId: string;
  protocolAttempted: string;
  statusBeforeProbe: string;
  started: boolean;
  dryRun: boolean;
  structuredError?: {
    code: string;
    message: string;
    safeContext?: Record<string, unknown>;
  };
}

function totalProtocolCount(): number {
  return listRuntimeExecutorCapabilities().reduce(
    (sum, capability) => sum + capability.protocols.length,
    0,
  );
}

describe('runtime adapter probe harness', () => {
  it('creates redacted dry-run reports without starting CLI processes or overclaiming ACP', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'omniforge-runtime-probes-'));
    try {
      const command = process.platform === 'win32' ? 'cmd' : 'pnpm';
      const args = process.platform === 'win32'
        ? ['/c', 'pnpm', 'exec', 'tsx', 'scripts/probe-runtime-adapters.ts', '--dry-run', '--out', outDir]
        : ['exec', 'tsx', 'scripts/probe-runtime-adapters.ts', '--dry-run', '--out', outDir];
      const result = spawnSync(
        command,
        args,
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            OMNIFORGE_PROBE_FAKE_SECRET: 'sk-probe-secret-1234567890',
          },
        },
      );

      expect(result.status, result.stderr || result.error?.message).toBe(0);
      const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')) as ProbeSummary;
      expect(summary.dryRun).toBe(true);
      expect(summary.reportCount).toBe(totalProtocolCount());
      expect(summary.reports).toHaveLength(totalProtocolCount());

      for (const item of summary.reports) {
        expect(item.started).toBe(false);
        expect(item.errorCode).toBe('runtime_probe_dry_run');

        const report = JSON.parse(readFileSync(item.artifactPath, 'utf8')) as ProbeReport;
        const reportJson = JSON.stringify(report);
        expect(report.dryRun).toBe(true);
        expect(report.started).toBe(false);
        expect(report.structuredError?.code).toBe('runtime_probe_dry_run');
        expect(reportJson).not.toContain('sk-probe-secret-1234567890');

        if (report.protocolAttempted === 'acp-stdio' || report.protocolAttempted === 'app-server-jsonrpc') {
          // Phase 8: opencode acp-stdio is now verified via live probe artifact
          // (`_artifacts/runtime-resume-harness/opencode-acp-smoke-2026-05-10T06-49-49Z.md`).
          // Other ACP/app-server-jsonrpc tiers stay unverified pending their own probes.
          if (report.executorId !== 'cli:opencode' || report.protocolAttempted !== 'acp-stdio') {
            expect(report.statusBeforeProbe).not.toBe('verified');
          }
        }
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('keeps protocol adapters structured and conservative before live verification', () => {
    const acpNoise = parseAcpJsonRpcLine('not json');
    expect(acpNoise.ok).toBe(false);
    expect(acpNoise.structuredError?.code).toBe('runtime_acp_non_json_stdout');

    const acpMessage = parseAcpJsonRpcLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    expect(acpMessage.ok).toBe(true);
    expect(acpMessage.message?.jsonrpc).toBe('2.0');

    const acpUnsupported = unsupportedAcpAdapter('cli:gemini', 'missing probe');
    expect(acpUnsupported.code).toBe('runtime_acp_adapter_unverified');
    expect(JSON.stringify(acpUnsupported)).toContain('cli:gemini');

    const jsonl = parseJsonlRuntimeOutput('{"type":"assistant.message","text":"ok"}\nnot json');
    expect(jsonl.events).toHaveLength(1);
    expect(jsonl.errors[0]?.code).toBe('runtime_jsonl_malformed_line');

    const server = decideServerJsonRpcProbe({
      executorId: 'cli:codex',
      statusBeforeProbe: 'experimental',
      endpoint: null,
    });
    expect(server.canUse).toBe(false);
    expect(server.structuredError?.code).toBe('runtime_server_jsonrpc_unverified');
  });
});
