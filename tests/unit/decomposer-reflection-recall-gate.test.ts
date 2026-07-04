// Week 4 / Task 3.3 — gate correctness for OMNIFORGE_REFLECTION_RECALL.
//
// The gate must be opt-in (default OFF): reflection recall fires ONLY when
// the env var is explicitly set to 'true'. All other values (unset, 'false',
// any other string) must produce an empty reflection block and leave
// recallReflections uncalled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('composeReflectionBlock — OMNIFORGE_REFLECTION_RECALL gate', () => {
  let originalEnv: string | undefined;

  // We stub recallReflections at the module level so we can verify whether it
  // was called without touching the real SQLite database.
  beforeEach(async () => {
    originalEnv = process.env.OMNIFORGE_REFLECTION_RECALL;
    // Reset the module registry so each test starts with a fresh import state
    // and can control the env var independently.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OMNIFORGE_REFLECTION_RECALL;
    } else {
      process.env.OMNIFORGE_REFLECTION_RECALL = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('does NOT fire when env var is unset', async () => {
    delete process.env.OMNIFORGE_REFLECTION_RECALL;

    const storeMod = await import('../../src/v2/reflection/store.js');
    const recallSpy = vi.spyOn(storeMod, 'recallReflections').mockReturnValue([]);

    // Import decomposer after the spy is in place so the module picks up the mock.
    const { decompose } = await import('../../src/brain/decomposer.js');

    // Stub the LLM call so decompose() returns without a real network request.
    const callMod = await import('../../src/utils/omniroute-call.js');
    vi.spyOn(callMod, 'callOmnirouteWithUsage').mockResolvedValue({
      content: JSON.stringify({
        tasks: [
          {
            id: 't0',
            name: 'Only task',
            kind: 'llm_call',
            depends_on: [],
            executor_hint: null,
            acceptance_criteria:
              'Returns a non-empty string result and exits with code 0, confirming successful execution',
            model: null,
          },
        ],
      }),
      usage: { input_tokens: 5, output_tokens: 10, total_cost_usd: 0 },
      model_used: 'cc/claude-sonnet-4-6',
    });

    await decompose('Write a short poem', {
      // No db provided — composeReflectionBlock returns early on !options.db
      // even before reaching recallReflections. Providing a fake db object
      // (truthy) forces the gate logic to be the deciding factor.
      db: {} as never,
    });

    expect(recallSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when env var is "false"', async () => {
    process.env.OMNIFORGE_REFLECTION_RECALL = 'false';

    const storeMod = await import('../../src/v2/reflection/store.js');
    const recallSpy = vi.spyOn(storeMod, 'recallReflections').mockReturnValue([]);

    const { decompose } = await import('../../src/brain/decomposer.js');

    const callMod = await import('../../src/utils/omniroute-call.js');
    vi.spyOn(callMod, 'callOmnirouteWithUsage').mockResolvedValue({
      content: JSON.stringify({
        tasks: [
          {
            id: 't0',
            name: 'Only task',
            kind: 'llm_call',
            depends_on: [],
            executor_hint: null,
            acceptance_criteria:
              'Returns a non-empty string result and exits with code 0, confirming successful execution',
            model: null,
          },
        ],
      }),
      usage: { input_tokens: 5, output_tokens: 10, total_cost_usd: 0 },
      model_used: 'cc/claude-sonnet-4-6',
    });

    await decompose('Write a short poem', { db: {} as never });

    expect(recallSpy).not.toHaveBeenCalled();
  });

  it('DOES fire when env var is "true"', async () => {
    process.env.OMNIFORGE_REFLECTION_RECALL = 'true';

    const storeMod = await import('../../src/v2/reflection/store.js');
    // Return an empty array — enough to prove recall was attempted; the block
    // will be '' because length === 0, but that is correct behavior.
    const recallSpy = vi.spyOn(storeMod, 'recallReflections').mockReturnValue([]);

    const { decompose } = await import('../../src/brain/decomposer.js');

    const callMod = await import('../../src/utils/omniroute-call.js');
    vi.spyOn(callMod, 'callOmnirouteWithUsage').mockResolvedValue({
      content: JSON.stringify({
        tasks: [
          {
            id: 't0',
            name: 'Only task',
            kind: 'llm_call',
            depends_on: [],
            executor_hint: null,
            acceptance_criteria:
              'Returns a non-empty string result and exits with code 0, confirming successful execution',
            model: null,
          },
        ],
      }),
      usage: { input_tokens: 5, output_tokens: 10, total_cost_usd: 0 },
      model_used: 'cc/claude-sonnet-4-6',
    });

    await decompose('Write a short poem', { db: {} as never });

    expect(recallSpy).toHaveBeenCalledOnce();
  });
});
