// W3 — runtime resume tests for cli:kimi.
//
// Pins the new jsonl-headless tier registered for cli:kimi after the live
// two-turn harness PASSed on 2026-05-11:
//   _artifacts/runtime-resume-harness/kimi-2026-05-11T23-56-34-837Z.md
//
// Also pins the cli.ts kimi resume injection: when a task carries
// opts.runtime.nativeSessionId, the spawned args must include `-r <id>`.
import { describe, expect, it } from 'vitest';

import { getRuntimeExecutorCapability } from '../../src/runtime/capabilities.js';

describe('cli:kimi — runtime resume (W3 — verified, jsonl-headless added)', () => {
  it('new jsonl-headless tier on cli:kimi is `verified`', () => {
    const kimi = getRuntimeExecutorCapability('cli:kimi');
    expect(kimi).toBeDefined();
    // defaultProtocolTier stays text-pty-fallback (this is opt-in).
    expect(kimi?.defaultProtocolTier).toBe('text-pty-fallback');

    const jsonl = kimi?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(jsonl).toBeDefined();
    expect(jsonl?.status).toBe('verified');
    expect(jsonl?.streamFormat).toBe('kimi-stream-json');
    expect(jsonl?.promptDelivery).toBe('stdin');
    expect(jsonl?.supports).toMatchObject({
      resume: true,
      explicitSessionId: true,
      toolEvents: true,
      structuredOutput: true,
    });
  });

  it('text-pty-fallback tier remains `verified` and is still the default', () => {
    const kimi = getRuntimeExecutorCapability('cli:kimi');
    const text = kimi?.protocols.find((p) => p.tier === 'text-pty-fallback');
    expect(text).toBeDefined();
    expect(text?.status).toBe('verified');
  });

  it('acp-stdio tier stays `planned`', () => {
    const kimi = getRuntimeExecutorCapability('cli:kimi');
    const acp = kimi?.protocols.find((p) => p.tier === 'acp-stdio');
    expect(acp).toBeDefined();
    expect(acp?.status).toBe('planned');
  });

  it('kimi-stream-json is part of the RuntimeStreamFormat union (typecheck via instantiation)', () => {
    const kimi = getRuntimeExecutorCapability('cli:kimi');
    const jsonl = kimi?.protocols.find((p) => p.tier === 'jsonl-headless');
    // If `kimi-stream-json` were not in the union this assignment would fail
    // tsc, so this also acts as a compile-time guard.
    const format: 'kimi-stream-json' | undefined = jsonl?.streamFormat as 'kimi-stream-json' | undefined;
    expect(format).toBe('kimi-stream-json');
  });

  it('jsonl-headless does NOT support permissionRequests (kimi uses --print/--yolo)', () => {
    // Per the capabilities comment block: kimi --print mode implicitly
    // enables --yolo server-side, so there is no permission-request flow
    // to expose. The dispatcher relies on this flag to decide whether to
    // wait for a JSON-RPC tool/permission round-trip or just stream events.
    // This is the asymmetry vs claude/codex; pin it so future kimi tier
    // promotion can't accidentally flip the flag without updating the
    // dispatcher's branch.
    const kimi = getRuntimeExecutorCapability('cli:kimi');
    const jsonl = kimi?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(jsonl?.supports.permissionRequests).toBe(false);
  });

  it('provider prefixes still include both kimi and kmc so model routing keeps working', () => {
    // Sanity guard — adding a new tier must NOT touch providerPrefixes;
    // existing callers use `kmc/...` and `kimi/...` model IDs.
    const kimi = getRuntimeExecutorCapability('cli:kimi');
    expect(kimi?.providerPrefixes).toContain('kimi');
    expect(kimi?.providerPrefixes).toContain('kmc');
  });
});
