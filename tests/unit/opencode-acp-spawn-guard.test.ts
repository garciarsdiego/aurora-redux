/**
 * Aurora dogfood fix (2026-05-31): a failed `opencode acp` spawn used to emit an
 * UNHANDLED 'error' event that crashed the entire orchestrator process (and every
 * concurrent task). The ACP client factory must now convert a spawn failure into
 * a clean Promise REJECTION — never an uncaught exception.
 *
 * This test would CRASH the worker (unhandled 'error') against the pre-fix code;
 * with the fix it resolves to a rejection and the process survives.
 */

import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildOpencodeAcpClientFactory } from '../../src/executors/cli/opencode-acp.js';

describe('opencode ACP spawn-error guard', () => {
  const original = process.env.OMNIFORGE_OPENCODE_BIN;
  beforeEach(() => { process.env.OMNIFORGE_OPENCODE_BIN = '/no/such/opencode-binary-xyz-12345'; });
  afterEach(() => {
    if (original === undefined) delete process.env.OMNIFORGE_OPENCODE_BIN;
    else process.env.OMNIFORGE_OPENCODE_BIN = original;
  });

  it('rejects (does NOT crash the process) when the opencode binary cannot be spawned', async () => {
    const factory = buildOpencodeAcpClientFactory();
    // Cast the minimal input the factory reads (workspacePath + env).
    const input = { workspacePath: tmpdir(), env: {} } as unknown as Parameters<typeof factory>[0];
    await expect(factory(input)).rejects.toThrow(/opencode acp (spawn failed|initialize failed)/i);
    // Reaching here at all proves the unhandled-'error' crash is fixed:
    // the bad spawn surfaced as a catchable rejection, not a process exit.
  });
});
