// W3 round 3 — runtime resume tests for cli:cursor.
//
// 2026-05-11 round 2 (Example correction): cursor's resume IS flag-based, but
// the syntax is `--resume=<uuid>` (with `=`, single arg), not the original
// W3 probe's `--resume <uuid>` (space-separated, two args). Combined with
// `--output-format stream-json`, cursor emits `session_id` on every event,
// landing on the first `system.init` event within ~200ms of turn 1.
//
// Live two-turn harness 2026-05-11: PASS (43s wall-clock, session_id pin
// preserved across both turns).
// Evidence:
//   _artifacts/runtime-resume-harness/cursor-2026-05-11T-PASS.md
//
// This file pins:
//   1. jsonl-headless tier `status: 'verified'` with FULL claude-parity
//      supports (resume + explicitSessionId + structuredOutput + toolEvents).
//   2. defaultProtocolTier = `'jsonl-headless'` (was 'text-pty-fallback').
//   3. text-pty-fallback stays `verified` as a backup tier.
import { describe, expect, it } from 'vitest';

import { getRuntimeExecutorCapability } from '../../src/runtime/capabilities.js';

describe('cli:cursor — runtime resume (W3 round 3 — verified via stream-json + --resume=<uuid>)', () => {
  it('jsonl-headless tier is `verified` with full claude-parity supports', () => {
    const cursor = getRuntimeExecutorCapability('cli:cursor');
    expect(cursor).toBeDefined();

    const jsonl = cursor?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(jsonl).toBeDefined();
    expect(jsonl?.status).toBe('verified');
    expect(jsonl?.streamFormat).toBe('cursor-stream-json');
    expect(jsonl?.supports.resume).toBe(true);
    // The `=` form (`--resume=<uuid>`) pins to a specific session — Aurora
    // can run parallel cursor invocations within the same workspace
    // without cross-contamination (unlike the earlier "latest chat" theory).
    expect(jsonl?.supports.explicitSessionId).toBe(true);
    expect(jsonl?.supports.toolEvents).toBe(true);
    expect(jsonl?.supports.structuredOutput).toBe(true);
    expect(jsonl?.supports.cancellation).toBe(true);
  });

  it('defaultProtocolTier is `jsonl-headless` (cursor now matches claude/codex routing)', () => {
    const cursor = getRuntimeExecutorCapability('cli:cursor');
    expect(cursor?.defaultProtocolTier).toBe('jsonl-headless');
    const def = cursor?.protocols.find((p) => p.tier === cursor?.defaultProtocolTier);
    expect(def?.status).toBe('verified');
    expect(def?.supports.resume).toBe(true);
    expect(def?.supports.explicitSessionId).toBe(true);
  });

  it('text-pty-fallback tier remains `verified` as backup for stream-json-incompatible env', () => {
    const cursor = getRuntimeExecutorCapability('cli:cursor');
    const text = cursor?.protocols.find((p) => p.tier === 'text-pty-fallback');
    expect(text).toBeDefined();
    expect(text?.status).toBe('verified');
    // resume still works without stream-json — cursor honours --resume=<uuid>
    // regardless of output format. Only the structured event surface differs.
    expect(text?.supports.resume).toBe(true);
    expect(text?.supports.explicitSessionId).toBe(true);
    expect(text?.supports.structuredOutput).toBe(false);
  });

  it('reports cancellation supported on both tiers (SIGTERM/tree-kill on cursor spawns)', () => {
    const cursor = getRuntimeExecutorCapability('cli:cursor');
    const text = cursor?.protocols.find((p) => p.tier === 'text-pty-fallback');
    const jsonl = cursor?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(text?.supports.cancellation).toBe(true);
    expect(jsonl?.supports.cancellation).toBe(true);
  });

  it('baseArgs include stream-json output (matches verified injection contract)', () => {
    const cursor = getRuntimeExecutorCapability('cli:cursor');
    expect(cursor?.baseArgs).toContain('-p');
    expect(cursor?.baseArgs).toContain('--output-format');
    expect(cursor?.baseArgs).toContain('stream-json');
  });
});
