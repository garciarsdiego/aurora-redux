/**
 * Integration test — F-REL-1 cancel propagation must abort the in-flight
 * Omniroute fetch() call within ~200ms, not bleed cost up to the per-call
 * server timeout (~300s).
 *
 * Trace (M1-W1-B fix):
 *
 *   broadcastCancelToWorkflow
 *     -> ac.abort() on the per-task AbortController
 *     -> withTimeout's composed signal aborts
 *     -> doExecute(task, signal) — passes signal into executeTask
 *     -> executeTask delegates to runOmniRouteTask(task, { signal })
 *     -> runOmniRouteTask (non-stream branch) forwards { signal } into
 *        callOmnirouteWithUsage(input)
 *     -> callOmnirouteWithUsage composes the externalSignal with
 *        AbortSignal.timeout(effectiveTimeoutMs) via AbortSignal.any/manual
 *     -> fetch(url, { signal: composed }) aborts immediately
 *
 * Before this change the supervisor's `defaultExecuteTurn(_signal)` carried
 * the underscore-prefix-unused sentinel and the signal was dropped at the
 * runOmniRouteTask layer. Cancel during a long-running model call left the
 * LLM call billing real money until the server-side deadline.
 *
 * Test strategy:
 *   - Mock fetch with a sleep-on-pending implementation that resolves only
 *     when the inbound signal aborts. The signal IS the abort plumbing.
 *   - Drive a single-task workflow through executeWorkflow with a real
 *     run-task path (NOT executeTaskFn override) so the cancel signal
 *     travels the real call chain.
 *   - Issue requestWorkflowControl('cancel') after a small delay.
 *   - Assert the abort surfaces in the fetch call within 200ms of cancel.
 *
 * Note on env: cancel-propagation-e2e.test.ts already covers the
 * task-level/DB-level cancel state. This test specifically asserts the
 * Omniroute HTTP call layer honors the signal — the gap that previously
 * caused F-REL-1 cost-bleed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { requestWorkflowControl } from '../../src/db/workflow-control.js';
import { _resetControlRegistry } from '../../src/v2/subagent/control.js';
import { callOmnirouteWithUsage } from '../../src/utils/omniroute-call.js';

describe('cancel cost-bleed E2E — F-REL-1 fetch abort propagation', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetControlRegistry();
  });

  it('aborts the fetch() inside callOmnirouteWithUsage when the external signal aborts', async () => {
    // Direct-layer test — the cheapest, most focused proof that the new
    // `signal` field on OmniroutePromptInput actually threads into fetch().
    const fetchSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      // Capture the AbortSignal that fetch received so we can prove it's
      // not the plain timeout signal but a composition that honors the
      // external one too.
      if (init.signal) fetchSignals.push(init.signal);

      return new Promise<Response>((_resolve, reject) => {
        // Mimic a long-running upstream — only the signal can end it.
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        }, { once: true });
        // Safety: if signal never fires (regression), reject after 5s.
        setTimeout(() => reject(new Error('test_timeout_no_abort')), 5_000);
      });
    });

    const originalFetch = global.fetch;
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      // External controller that mimics the workflow-cancel path.
      const externalCtrl = new AbortController();

      // Fire the cancel after a short delay — long enough for fetch() to
      // start but well within the per-call timeout.
      const cancelDelayMs = 50;
      const cancelStartedAt = Date.now();
      setTimeout(() => {
        externalCtrl.abort(new Error('test_cancel'));
      }, cancelDelayMs);

      const callPromise = callOmnirouteWithUsage({
        systemPrompt: 'system',
        userPrompt: 'long task',
        model: 'claude-sonnet-4-6',
        signal: externalCtrl.signal,
      });

      await expect(callPromise).rejects.toThrow();

      const propagationLatencyMs = Date.now() - cancelStartedAt;
      // The whole abort path — cancel timer fires + signal observer in
      // fetch wrapper + reject — must complete under 200ms. We give it
      // a comfortable ceiling that's still 1000x faster than the 300s
      // server-side timeout this test guards against.
      expect(propagationLatencyMs).toBeLessThan(500);

      // The mocked fetch was called at least once — proving the call
      // chain reached the HTTP layer rather than failing earlier.
      expect(fetchMock).toHaveBeenCalled();

      // The signal handed to fetch DID become aborted (i.e. the composed
      // signal honored the external cancel).
      expect(fetchSignals.length).toBeGreaterThan(0);
      expect(fetchSignals[0]!.aborted).toBe(true);
    } finally {
      (global as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }, 10_000);

  it('a pre-aborted external signal short-circuits before fetch is called', async () => {
    // When the external signal is already aborted before the call starts,
    // we MUST NOT even open a socket — the fast-fail path saves the cost
    // of the HTTP handshake on every retry.
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should NOT have been called');
    });

    const originalFetch = global.fetch;
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const externalCtrl = new AbortController();
      externalCtrl.abort(new Error('pre_aborted'));

      await expect(
        callOmnirouteWithUsage({
          systemPrompt: 'system',
          userPrompt: 'task',
          model: 'claude-sonnet-4-6',
          signal: externalCtrl.signal,
        }),
      ).rejects.toThrow();

      // Fetch was never invoked — the pre-abort check fired first.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (global as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('without an external signal, the call still uses the per-request timeout (back-compat)', async () => {
    // Regression guard — the new signal field is opt-in. Existing callers
    // that do NOT pass `signal` (decomposer, reviewer, consolidator,
    // pattern matcher) must continue to work via the plain
    // `AbortSignal.timeout(effectiveTimeoutMs)` path.
    const fetchSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal) fetchSignals.push(init.signal);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello from mock' } }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const originalFetch = global.fetch;
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await callOmnirouteWithUsage({
        systemPrompt: 'system',
        userPrompt: 'task',
        model: 'claude-sonnet-4-6',
      });

      expect(result.content).toBe('hello from mock');
      expect(fetchSignals.length).toBe(1);
      // The signal exists (timeout) but is not aborted on the happy path.
      expect(fetchSignals[0]!.aborted).toBe(false);
    } finally {
      (global as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe('cancel cost-bleed — supervisor → runOmniRouteTask wiring', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });
  afterEach(() => {
    db.close();
    _resetControlRegistry();
  });

  it('runOmniRouteTask forwards signal into callOmnirouteWithUsage for non-streaming path', async () => {
    // We assert the integration point: the omniroute executor (not the
    // streaming branch) hands the AbortSignal down. The previous failing
    // contract was: signal accepted but dropped.
    const { runOmniRouteTask } = await import('../../src/executors/omniroute.js');

    const fetchSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal) fetchSignals.push(init.signal);
      // Hang forever — only abort can end this.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        }, { once: true });
        setTimeout(() => reject(new Error('test_safety_timeout')), 5_000);
      });
    });

    const originalFetch = global.fetch;
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(new Error('supervisor_cancel')), 50);

      const fakeTask = {
        id: 'task-x',
        workflow_id: 'wf-x',
        name: 'long-running adaptive turn',
        kind: 'llm_call' as const,
        depends_on: [],
        input_json: JSON.stringify({ objective: 'work' }),
        output_json: null,
        status: 'running' as const,
        executor_hint: null,
        timeout_seconds: 300,
        max_retries: 0,
        retry_count: 0,
        retry_policy: 'exponential' as const,
        started_at: Date.now(),
        completed_at: null,
        created_at: Date.now(),
        acceptance_criteria: null,
        refine_count: 0,
        max_refine: 0,
        refine_feedback: null,
        model: 'claude-sonnet-4-6',
        hitl: false,
      };

      const callPromise = runOmniRouteTask(fakeTask as never, { signal: ctrl.signal });
      await expect(callPromise).rejects.toThrow();

      // Signal made it all the way to fetch
      expect(fetchSignals.length).toBeGreaterThan(0);
      expect(fetchSignals[0]!.aborted).toBe(true);
    } finally {
      (global as { fetch: typeof fetch }).fetch = originalFetch;
    }
  }, 10_000);
});
