/**
 * Wave 3.D: tests for the stream-fork dispatcher.
 *
 * Covers: scheduling under concurrency cap, fork-on-completion (a slow
 * task does NOT block its already-finished siblings' downstream
 * dependents from launching), error isolation across siblings, and the
 * onComplete handler's `enqueue` callback that fuels the dispatch loop.
 */

import { describe, expect, it } from 'vitest';

import {
  dispatchStreamFork,
  type StreamForkTask,
} from '../../src/brain/executor/stream-fork-dispatcher.js';

interface T extends StreamForkTask<string> {
  id: string;
  duration_ms: number;
  /** When > 0, throw after `duration_ms` instead of resolving. */
  fail?: boolean;
}

function asTask(id: string, duration_ms: number, opts: { fail?: boolean } = {}): T {
  return { id, duration_ms, ...(opts.fail ? { fail: true } : {}) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('dispatchStreamFork', () => {
  it('runs every initial task once and reports completion in finish order', async () => {
    const finishOrder: string[] = [];
    const result = await dispatchStreamFork<T, string>({
      initialReady: [asTask('slow', 30), asTask('fast', 5), asTask('mid', 15)],
      maxConcurrency: 0, // unlimited
      run: async (task) => {
        await delay(task.duration_ms);
      },
      onComplete: (task) => { finishOrder.push(task.id); },
    });

    expect(finishOrder).toEqual(['fast', 'mid', 'slow']);
    expect(result.completed.map((t) => t.id)).toEqual(['fast', 'mid', 'slow']);
    expect(result.failed).toEqual([]);
  });

  it('respects maxConcurrency, draining ready queue in submit order', async () => {
    const launchedAt: Record<string, number> = {};
    const start = Date.now();
    await dispatchStreamFork<T, string>({
      initialReady: [
        asTask('a', 30),
        asTask('b', 30),
        asTask('c', 30),
        asTask('d', 30),
      ],
      maxConcurrency: 2,
      run: async (task) => {
        launchedAt[task.id] = Date.now() - start;
        await delay(task.duration_ms);
      },
      onComplete: () => {},
    });

    // a and b launch immediately; c and d wait for a slot.
    expect(launchedAt['a']!).toBeLessThan(15);
    expect(launchedAt['b']!).toBeLessThan(15);
    expect(launchedAt['c']!).toBeGreaterThanOrEqual(20);
    expect(launchedAt['d']!).toBeGreaterThanOrEqual(20);
  });

  it('forks newly-enqueued tasks the moment a sibling finishes', async () => {
    // Workflow shape:
    //   slow (60ms) ─┐
    //                ├─ never blocks B
    //   fast (5ms)  ─┴─ unlocks fast_dep, which depends on `fast` only.
    //
    // Stream-fork should launch fast_dep at t≈5ms (right after `fast`
    // resolves), NOT at t≈60ms (when `slow` would finish). Validates the
    // core advantage over the legacy batch-and-wait loop.
    const order: string[] = [];
    const start = Date.now();
    const stamp = (id: string): void => {
      order.push(`${id}@${Math.round((Date.now() - start) / 5) * 5}`);
    };

    await dispatchStreamFork<T, string>({
      initialReady: [asTask('slow', 60), asTask('fast', 5)],
      maxConcurrency: 0,
      run: async (task) => {
        stamp(`run_start_${task.id}`);
        await delay(task.duration_ms);
        stamp(`run_end_${task.id}`);
      },
      onComplete: (task, api) => {
        stamp(`complete_${task.id}`);
        if (task.id === 'fast') {
          api.enqueue(asTask('fast_dep', 5));
        }
      },
    });

    const fastEndIdx = order.findIndex((s) => s.startsWith('run_end_fast'));
    const fastDepStartIdx = order.findIndex((s) => s.startsWith('run_start_fast_dep'));
    const slowEndIdx = order.findIndex((s) => s.startsWith('run_end_slow'));

    // fast_dep MUST start before slow ends — that's the whole point of stream-fork.
    expect(fastDepStartIdx).toBeGreaterThan(fastEndIdx);
    expect(fastDepStartIdx).toBeLessThan(slowEndIdx);
  });

  it('isolates failures: one task rejecting does not abort siblings', async () => {
    const completed: string[] = [];
    const failed: string[] = [];
    const result = await dispatchStreamFork<T, string>({
      initialReady: [
        asTask('a', 10),
        asTask('b', 5, { fail: true }),
        asTask('c', 15),
      ],
      maxConcurrency: 0,
      run: async (task) => {
        await delay(task.duration_ms);
        if (task.fail) throw new Error(`task ${task.id} blew up`);
      },
      onComplete: (task) => { completed.push(task.id); },
      onError: (task) => { failed.push(task.id); },
    });

    expect(completed.sort()).toEqual(['a', 'c']);
    expect(failed).toEqual(['b']);
    expect(result.completed.map((t) => t.id).sort()).toEqual(['a', 'c']);
    expect(result.failed.map((f) => f.task.id)).toEqual(['b']);
    expect((result.failed[0]?.error as Error).message).toContain('task b blew up');
  });

  it('lets onComplete enqueue successor tasks indefinitely (drains queue)', async () => {
    // Chain a → b → c → d via successive enqueue() calls. Single concurrency
    // slot to make the order deterministic.
    const order: string[] = [];
    const successors: Record<string, string | null> = {
      a: 'b', b: 'c', c: 'd', d: null,
    };
    await dispatchStreamFork<T, string>({
      initialReady: [asTask('a', 5)],
      maxConcurrency: 1,
      run: async (task) => {
        order.push(task.id);
        await delay(task.duration_ms);
      },
      onComplete: (task, api) => {
        const next = successors[task.id];
        if (next) api.enqueue(asTask(next, 5));
      },
    });

    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('treats an onComplete handler error as a task failure (no silent loss)', async () => {
    const result = await dispatchStreamFork<T, string>({
      initialReady: [asTask('only', 5)],
      maxConcurrency: 0,
      run: async () => { /* succeed */ },
      onComplete: () => { throw new Error('handler boom'); },
    });
    expect(result.completed.map((t) => t.id)).toEqual(['only']);
    expect(result.failed).toHaveLength(1);
    expect((result.failed[0]?.error as Error).message).toBe('handler boom');
  });

  it('returns immediately when initialReady is empty', async () => {
    const result = await dispatchStreamFork<T, string>({
      initialReady: [],
      maxConcurrency: 4,
      run: async () => {},
      onComplete: () => {},
    });
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
