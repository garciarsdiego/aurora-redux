// Shared test helper: Windows-resilient temp-dir cleanup for integration
// tests that spin a daemon (startHttpMcpServer) over a SQLite WAL database.
//
// Background (P3 test-harness stability):
//   On Windows, better-sqlite3 opens the DB plus its WAL/SHM sidecar files
//   (`*.db-wal`, `*.db-shm`). The `-shm` file is memory-mapped, and Windows
//   does not release the underlying file handle synchronously when the
//   connection is closed — there is a short OS-level grace window. If
//   `rmSync` runs inside that window it throws `EPERM: operation not
//   permitted` (or `EBUSY`) on the directory. The plain
//   `{ recursive: true, force: true }` form does NOT retry on EPERM, only on
//   EBUSY/ENOTEMPTY, so a single EPERM aborts teardown and fails the whole
//   file in `afterAll`.
//
// This helper makes teardown deterministic by:
//   1. Using a generous retry budget (maxRetries + retryDelay) so the OS has
//      time to release the mapped handle.
//   2. Treating a leftover temp dir as non-fatal: a stray dir under the OS
//      temp root is harmless (the OS reclaims `%TEMP%` / `/tmp` eventually)
//      and must never fail an otherwise-green test. We log to stderr instead.
//
// Both `webhook-rate-limit.test.ts` and `dashboard-http.test.ts` use this in
// their `afterAll`. A short pre-removal delay should already have elapsed
// (callers `await sleep(...)` after `shutdown()` / `db.close()`); this helper
// adds the retry safety net on top.

import { rmSync } from 'node:fs';

/**
 * Remove a directory recursively, resilient to the transient Windows
 * EPERM/EBUSY window where a just-closed SQLite WAL/SHM handle is still being
 * released by the OS. Never throws — a failure to delete a temp dir is logged
 * and swallowed so it cannot turn a passing test red.
 *
 * @param dir Absolute path to the directory to remove.
 * @param maxRetries How many times `rmSync` retries internally on EBUSY/EPERM
 *   (default 10). Each retry waits `retryDelay` ms.
 * @param retryDelay Delay in ms between internal retries (default 150).
 */
export function removeTempDirSafe(dir: string, maxRetries = 10, retryDelay = 150): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay });
  } catch (err) {
    // Best-effort: a leftover temp dir is harmless. Do NOT rethrow — the OS
    // reclaims the temp root, and failing teardown here would mask a green
    // test run (the exact P3 flake we are eliminating). Log so it is still
    // visible during local triage.
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
    process.stderr.write(
      `[test-cleanup] could not remove temp dir ${dir} (${code}); leaving it for the OS to reclaim\n`,
    );
  }
}
