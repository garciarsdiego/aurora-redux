// W3 — runtime resume tests for cli:codex.
//
// Pins the capability promotion (experimental → verified) for the
// jsonl-headless tier on cli:codex after the live two-turn harness PASSed:
//   _artifacts/runtime-resume-harness/codex-2026-05-11T23-47-08-775Z.md
//
// Also pins the harness-side flag construction: turn 1 must NOT pass
// `--ephemeral`, otherwise `codex exec resume <id>` cannot find the rollout
// on the next process. This is a regression guard.
import { describe, expect, it } from 'vitest';

import { getRuntimeExecutorCapability } from '../../src/runtime/capabilities.js';
import { buildTurn1Args, buildTurn2Args } from '../../scripts/runtime-resume-harness/codex-two-turn.mjs';

describe('cli:codex — runtime resume (W3 — verified)', () => {
  it('jsonl-headless tier on cli:codex is now `verified` and is the defaultProtocolTier', () => {
    const codex = getRuntimeExecutorCapability('cli:codex');
    expect(codex).toBeDefined();
    expect(codex?.defaultProtocolTier).toBe('jsonl-headless');

    const jsonl = codex?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(jsonl).toBeDefined();
    expect(jsonl?.status).toBe('verified');
    expect(jsonl?.streamFormat).toBe('codex-jsonl');
    expect(jsonl?.promptDelivery).toBe('stdin');
    expect(jsonl?.supports).toMatchObject({
      resume: true,
      explicitSessionId: true,
      toolEvents: true,
      structuredOutput: true,
    });
  });

  it('harness buildTurn1Args does NOT include --ephemeral (resume rollout regression guard)', () => {
    const args = buildTurn1Args();
    expect(args).not.toContain('--ephemeral');
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('harness buildTurn2Args(<id>) emits `exec resume <id> --json --skip-git-repo-check`', () => {
    const sessionId = '019e196f-fe8b-72a1-8f75-3795e6fcdcf1';
    const args = buildTurn2Args(sessionId);
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('resume');
    expect(args[2]).toBe(sessionId);
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('buildTurn2Args throws when sessionId is empty', () => {
    expect(() => buildTurn2Args('')).toThrow(/sessionId/);
  });

  it('reports cancellation + permissionRequests so the dispatcher can wire signals', () => {
    // Contract regression guard for the dispatcher in src/executors/cli.ts:
    // verified jsonl-headless codex must expose cancellation/permission/
    // toolEvents/structuredOutput so the runtime adapter can wire SIGTERM
    // and JSON-RPC permission flows without falling back to text-pty.
    const codex = getRuntimeExecutorCapability('cli:codex');
    const jsonl = codex?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(jsonl?.supports.cancellation).toBe(true);
    expect(jsonl?.supports.permissionRequests).toBe(true);
    expect(jsonl?.supports.toolEvents).toBe(true);
    expect(jsonl?.supports.structuredOutput).toBe(true);
  });

  it('text-pty-fallback tier stays `verified` and remains a working alternative', () => {
    // Promotion of jsonl-headless to default must NOT drop the pty fallback —
    // some callers may still opt into the text path via opts.runtime.
    const codex = getRuntimeExecutorCapability('cli:codex');
    const text = codex?.protocols.find((p) => p.tier === 'text-pty-fallback');
    expect(text).toBeDefined();
    expect(text?.status).toBe('verified');
  });
});
