import { describe, expect, it } from 'vitest';

import {
  dangerousArgsInBaseCapabilities,
  getRuntimeExecutorCapability,
  listRuntimeExecutorCapabilities,
  runtimeExecutorForModel,
} from '../../src/runtime/capabilities.js';

describe('runtime executor capabilities', () => {
  it('declares protocol metadata for supported workflow CLIs', () => {
    const ids = listRuntimeExecutorCapabilities().map((capability) => capability.executorId);

    expect(ids).toEqual(expect.arrayContaining([
      'cli:claude-code',
      'cli:codex',
      'cli:gemini',
      'cli:kimi',
      'cli:opencode',
      'cli:cursor',
    ]));
    for (const capability of listRuntimeExecutorCapabilities()) {
      expect(capability.protocols.length).toBeGreaterThan(0);
      expect(capability.defaultProtocolTier).toBeTruthy();
      expect(capability.baseArgs).toEqual(expect.any(Array));
    }
  });

  it('keeps dangerous flags out of base capability descriptors', () => {
    expect(dangerousArgsInBaseCapabilities()).toEqual([]);
  });

  it('maps model provider prefixes to the expected runtime executor', () => {
    expect(runtimeExecutorForModel('cx/gpt-5.4')).toBe('cli:codex');
    expect(runtimeExecutorForModel('cc/claude-sonnet-4-6')).toBe('cli:claude-code');
    expect(runtimeExecutorForModel('gemini-cli/gemini-2.5-pro')).toBe('cli:gemini');
    expect(runtimeExecutorForModel('kmc/kimi-k2.5')).toBe('cli:kimi');
  });

  it('marks ACP/server protocols as planned or experimental until probed', () => {
    const codex = getRuntimeExecutorCapability('cli:codex');
    const gemini = getRuntimeExecutorCapability('cli:gemini');

    // W3 (2026-05-11): codex jsonl-headless flipped to `verified` after live
    // two-turn resume harness PASS — see capabilities.ts evidence comment.
    expect(codex?.protocols.find((protocol) => protocol.tier === 'jsonl-headless')?.status)
      .toBe('verified');
    expect(codex?.protocols.find((protocol) => protocol.tier === 'text-pty-fallback')?.status)
      .toBe('verified');
    expect(codex?.protocols.find((protocol) => protocol.tier === 'app-server-jsonrpc')?.status)
      .toBe('experimental');
    expect(gemini?.protocols.find((protocol) => protocol.tier === 'acp-stdio')?.status)
      .toBe('planned');
  });
});
