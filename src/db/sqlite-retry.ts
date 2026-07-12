/**
 * SQLite retry helpers (F3-3).
 *
 * better-sqlite3 surfaces transient locking conditions as exceptions with the
 * `code` property set to one of `SQLITE_BUSY`, `SQLITE_LOCKED`, or
 * `SQLITE_BUSY_SNAPSHOT`. These are typically caused by concurrent writers in
 * WAL mode or by a checkpoint that needs to wait for readers. They are safe
 * to retry — the database state has not been mutated, the prepared statement
 * just couldn't acquire its lock yet.
 *
 * The sync helper exists because better-sqlite3 is itself synchronous; the
 * critical insert paths in persist.ts cannot trivially be made async without
 * cascading through the entire executor. The async helper is provided for
 * callers that already operate in promise land (worker pools, retry-after-IO
 * patterns).
 */

const RETRY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT']);
const DEFAULT_BACKOFF_MS = [10, 40, 100, 250];

export interface SqliteRetryOptions {
  retries?: number;
  backoffMs?: number[];
  onRetry?: (attempt: number, err: Error) => void;
}

/**
 * Returns true if the error is a transient SQLite contention condition that
 * can be safely retried. Exposed for tests + callers that want to make
 * retry decisions outside of `withSqliteRetrySync`.
 */
const BUSY_MESSAGE_RE = /\b(?:database is locked|SQLITE_BUSY|SQLITE_LOCKED)\b/i;

export function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && RETRY_CODES.has(code)) return true;
  // Fallback: better-sqlite3 sometimes surfaces these without setting `code`
  // (e.g., older driver paths or composite errors). Match the message.
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && BUSY_MESSAGE_RE.test(message);
}

function backoffAt(backoff: number[], attempt: number): number {
  return backoff[attempt] ?? backoff[backoff.length - 1] ?? 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synchronous retry wrapper for better-sqlite3 statements.
 *
 * On `SQLITE_BUSY` / `SQLITE_LOCKED` / `SQLITE_BUSY_SNAPSHOT`, retries up to
 * `retries` times (default: backoff array length) using a busy-wait between
 * attempts. The busy-wait is unfortunate but unavoidable in a sync API; in
 * practice the contention is short-lived (low milliseconds) and the alternative
 * (rewriting every persist.ts call site to async) is much worse.
 */
export function withSqliteRetrySync<T>(fn: () => T, opts: SqliteRetryOptions = {}): T {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxRetries = opts.retries ?? backoff.length;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusy(err) || attempt === maxRetries) throw err;
      opts.onRetry?.(attempt, err as Error);
      // Synchronous busy-wait — better-sqlite3 is sync; we emulate backoff with a tight loop.
      const waitUntil = Date.now() + backoffAt(backoff, attempt);
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  throw lastErr;
}

/**
 * Async retry wrapper for callers already in promise-land.
 */
export async function withSqliteRetry<T>(
  fn: () => Promise<T> | T,
  opts: SqliteRetryOptions = {},
): Promise<T> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxRetries = opts.retries ?? backoff.length;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusy(err) || attempt === maxRetries) throw err;
      opts.onRetry?.(attempt, err as Error);
      await sleep(backoffAt(backoff, attempt));
    }
  }
  throw lastErr;
}
