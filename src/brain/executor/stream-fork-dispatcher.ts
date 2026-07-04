/**
 * Wave 3.D — stream-fork dispatcher.
 *
 * Adoption-ready building block for the executor's "stream-fork" upgrade
 * (see orchestrate.ts line ~234 comment). It is INTENTIONALLY NOT yet wired
 * into runTaskLoop — switching the live executor over to this scheduler
 * deserves its own session with end-to-end smoke runs. This module captures
 * the algorithm + the tests so the next adopter only needs to swap the
 * call site and validate, not redesign.
 *
 * Why stream-fork: today's runTaskLoop dispatches a batch of ready tasks,
 * Promise.allSettled-waits for ALL of them, then recomputes the ready set.
 * A 60s task in a batch with a 5s task delays the 5s task's downstream
 * dependents by 55s. Stream-fork closes that gap: as soon as ANY task
 * finishes, we recompute ready AND launch newly-ready dependents
 * immediately, while the slower siblings are still running.
 *
 * Algorithm:
 *   1. Maintain a `running` pool of in-flight task promises tagged with
 *      their task identity.
 *   2. Maintain a `ready` queue of tasks waiting for a slot.
 *   3. While `running ∪ ready` non-empty:
 *      a. Pull from `ready` into `running` until concurrency cap reached.
 *      b. Promise.race the running pool to learn which task finishes next.
 *      c. Notify caller (`onComplete` or `onError`) so it can update DB,
 *         emit events, and recompute the ready set.
 *      d. Caller pushes any newly-ready tasks into the queue via the
 *         returned `enqueue(t)` callback.
 *   4. Return when both pools drain.
 *
 * Failure semantics (matches Promise.allSettled in runTaskLoop today):
 *   - Errors do NOT abort sibling tasks. Each task either resolves
 *     successfully or rejects; the orchestrator picks the first rejection
 *     and propagates it AFTER all currently-running siblings settle.
 *   - This deliberately mirrors the existing executor contract so the
 *     swap-in is behaviour-preserving for the non-fork pieces.
 */

export interface StreamForkTask<TId> {
  /** Stable identifier — used for cancellation / lookup. Must be unique within a single dispatch run. */
  readonly id: TId;
}

export interface StreamForkOptions<T extends StreamForkTask<TId>, TId> {
  /** Tasks ready to run on entry. Caller may push more later via the enqueue callback. */
  readonly initialReady: readonly T[];
  /** Hard cap on parallelism. <= 0 means "unlimited". */
  readonly maxConcurrency: number;
  /**
   * Execute one task. Resolves on success, rejects on failure. Errors are
   * surfaced via `onError` rather than propagated immediately, matching
   * the Promise.allSettled semantics of the legacy loop.
   */
  readonly run: (task: T) => Promise<void>;
  /**
   * Called once per task that completes successfully. Caller typically
   * uses this to mark the task complete in the DB and recompute the
   * ready set, then pushes new tasks via `enqueue`.
   */
  readonly onComplete: (
    task: T,
    api: { enqueue(next: T): void },
  ) => void | Promise<void>;
  /**
   * Called once per task that rejected. Caller may still enqueue more
   * tasks (e.g. follow-up cleanup); whether to halt is the caller's call
   * — `dispatchStreamFork` collects rejections and returns them all at
   * the end.
   */
  readonly onError?: (
    task: T,
    err: unknown,
    api: { enqueue(next: T): void },
  ) => void | Promise<void>;
}

export interface StreamForkResult<T> {
  /** Tasks that resolved successfully, in completion order (NOT submit order). */
  readonly completed: readonly T[];
  /** Tasks that rejected, in completion order with their error. */
  readonly failed: readonly { task: T; error: unknown }[];
}

/**
 * Drain the ready queue with stream-fork dispatch. Returns once every task
 * (initial + enqueued during execution) has settled. Never throws — errors
 * surface via the returned `failed` array AND the caller's `onError`.
 */
export async function dispatchStreamFork<T extends StreamForkTask<TId>, TId>(
  opts: StreamForkOptions<T, TId>,
): Promise<StreamForkResult<T>> {
  const { initialReady, maxConcurrency, run, onComplete, onError } = opts;
  const cap = maxConcurrency > 0 ? maxConcurrency : Number.POSITIVE_INFINITY;

  const ready: T[] = [...initialReady];
  // Map of task id → tagged in-flight promise. Promise.race over .values()
  // tells us which task finishes next without losing identity.
  const running = new Map<TId, Promise<{ task: T; ok: true } | { task: T; ok: false; error: unknown }>>();
  const completed: T[] = [];
  const failed: { task: T; error: unknown }[] = [];

  function launch(task: T): void {
    const p = run(task)
      .then(
        () => ({ task, ok: true } as const),
        (error: unknown) => ({ task, ok: false, error } as const),
      );
    running.set(task.id, p);
  }

  function tryLaunchUpTo(): void {
    while (running.size < cap && ready.length > 0) {
      const next = ready.shift()!;
      launch(next);
    }
  }

  const enqueueApi = {
    enqueue(next: T): void {
      ready.push(next);
    },
  };

  tryLaunchUpTo();

  while (running.size > 0) {
    const settled = await Promise.race(running.values());
    running.delete(settled.task.id);

    if (settled.ok) {
      completed.push(settled.task);
      try {
        await onComplete(settled.task, enqueueApi);
      } catch (handlerErr) {
        // The completion handler itself failed — surface as a task error
        // so the caller doesn't silently lose the failure. Doesn't abort.
        failed.push({ task: settled.task, error: handlerErr });
      }
    } else {
      failed.push({ task: settled.task, error: settled.error });
      if (onError) {
        try { await onError(settled.task, settled.error, enqueueApi); } catch {
          // The error handler must not destabilise the loop. Swallow —
          // the original task error is already recorded in `failed`.
        }
      }
    }

    tryLaunchUpTo();
  }

  return { completed, failed };
}
