// Graceful shutdown — closes DB, flushes pending state, unmounts Ink.
// Idempotent: safe to call multiple times. Each step in its own try/catch
// so failure in one phase doesn't block subsequent cleanup.
//
// Sequence:
//   1. Mark shutdown in-progress (idempotency guard)
//   2. Flush any pending history writes (best-effort — appendHistory is already
//      sync at write site so usually no-op)
//   3. Close DB connection
//   4. Stderr-log the reason for diagnostics
//
// See docs/plans/REPL-LEVEL-D.md § 3.2 lifecycle.

import { getBootResult } from './bootstrap.js';
import { redact } from './utils/redaction.js';
import { errorMessage } from './utils/errors.js';

export type ShutdownReason = 'sigint' | 'sigterm' | 'sighup' | 'uncaught' | 'user-exit' | 'unhandled-rejection';

let _shuttingDown = false;

export async function gracefulShutdown(reason: ShutdownReason): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  const boot = getBootResult();
  process.stderr.write(`[repl] shutdown reason=${reason}\n`);

  // Step 1: Close DB connection.
  if (boot?.db) {
    try {
      boot.db.close();
    } catch (err: unknown) {
      process.stderr.write(`[repl] db.close warn: ${redact(errorMessage(err))}\n`);
    }
  }

  // Step 2: Drain stdout (best-effort — Ink does its own teardown via render's
  // returned controller, but App owns that today; in MA we just ensure stderr
  // flushes).
  try {
    await new Promise<void>((resolve) => {
      if (process.stderr.writable) {
        process.stderr.write('', () => resolve());
      } else {
        resolve();
      }
    });
  } catch {
    // ignore — stderr issues during shutdown are not actionable
  }

  // Step 3: Future hooks for MB+:
  //   - flush AbortRegistry (cancel inflight requests)
  //   - unsubscribe from daemon SSE streams
  //   - stop chokidar watchers (custom commands)
  //   - history rotation if oversize
}

/** Test-only: reset shutdown latch so subsequent tests can re-trigger. */
export function _resetShutdownLatch(): void {
  _shuttingDown = false;
}
