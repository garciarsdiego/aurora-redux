/**
 * Tier 0 Wave 3 (ITEM 0.2) — cancel signal propagation helper.
 *
 * The executor's task loop runs JS-level retry/refine cycles that previously
 * ignored AbortSignal aborts. broadcastCancelToWorkflow correctly aborts the
 * registered AbortController, but the surrounding code only saw the abort
 * when its current await happened to be wrapped in withTimeout (which catches
 * the timeout's own signal, not ours). The result was that cancelling a
 * workflow mid-retry left the loop running until the next natural break.
 *
 * checkAborted() yields to the abort at every reasonable checkpoint:
 *  - top of each retry attempt
 *  - before each task-kind dispatch (already wrapped in withTimeout via doExecute)
 *  - after each await of executor result
 *  - before/after review and refine
 *
 * We throw a typed AbortError (Error with name='AbortError') so downstream
 * catch blocks can distinguish a deliberate cancel from a real execution
 * failure. Node 22's signal.throwIfAborted() throws a DOMException whose
 * `name` is 'AbortError' too, but instanceof DOMException is awkward in
 * Node-land — using a plain Error keeps existing classifyError() paths
 * unchanged while still letting consumers check `(err as Error).name`.
 */
export function checkAborted(signal: AbortSignal | undefined, where: string): void {
  if (signal?.aborted) {
    // Security (Wave 5B Issue #1): do NOT embed signal.reason verbatim in the
    // error message. AbortError.message gets persisted to events / SSE / logs;
    // if a future caller passes secrets in the reason (`abort({token:...})`),
    // they would leak. Keep a stable, non-data-bearing message instead.
    // "cancelled" keyword is intentional — downstream regression tests + log
    // scanning match /cancel/i.
    const err = new Error(`task cancelled at ${where}`);
    (err as Error & { name: string }).name = 'AbortError';
    throw err;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
