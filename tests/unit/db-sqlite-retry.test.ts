import { describe, expect, it, vi } from 'vitest';

import {
  withSqliteRetry,
  withSqliteRetrySync,
} from '../../src/db/sqlite-retry.js';

function makeBusyError(code = 'SQLITE_BUSY'): Error & { code: string } {
  const err = new Error(`database is locked (${code})`) as Error & { code: string };
  err.code = code;
  return err;
}

describe('withSqliteRetrySync', () => {
  it('returns the value when the function succeeds on the first try', () => {
    const fn = vi.fn(() => 42);
    const result = withSqliteRetrySync(fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on SQLITE_BUSY and eventually succeeds', () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls < 3) throw makeBusyError('SQLITE_BUSY');
      return 'ok';
    });
    const onRetry = vi.fn();
    // Use tiny backoff to keep the test fast.
    const result = withSqliteRetrySync(fn, {
      backoffMs: [1, 1, 1, 1],
      onRetry,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', () => {
    const err = makeBusyError('SQLITE_LOCKED');
    const fn = vi.fn(() => {
      throw err;
    });
    expect(() =>
      withSqliteRetrySync(fn, { backoffMs: [1, 1], retries: 2 }),
    ).toThrow(err);
    // Initial attempt + 2 retries = 3 calls.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-retryable errors', () => {
    const fatal = new Error('schema mismatch') as Error & { code?: string };
    fatal.code = 'SQLITE_CORRUPT';
    const fn = vi.fn(() => {
      throw fatal;
    });
    expect(() => withSqliteRetrySync(fn, { backoffMs: [1] })).toThrow(fatal);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withSqliteRetry (async)', () => {
  it('returns the value when the function succeeds on the first try', async () => {
    const fn = vi.fn(async () => 'sync-ok');
    const result = await withSqliteRetry(fn);
    expect(result).toBe('sync-ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries SQLITE_BUSY_SNAPSHOT and resolves', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw makeBusyError('SQLITE_BUSY_SNAPSHOT');
      return 'recovered';
    });
    const result = await withSqliteRetry(fn, { backoffMs: [1, 1] });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const err = makeBusyError('SQLITE_BUSY');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(
      withSqliteRetry(fn, { backoffMs: [1, 1], retries: 2 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
