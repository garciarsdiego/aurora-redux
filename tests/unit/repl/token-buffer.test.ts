// TokenBuffer unit tests (D-H2.029).
// Validates: push semantics, FIFO drop on overflow, useSyncExternalStore
// snapshot stability, batched notifications via setImmediate.

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenBuffer, resetTokenBuffer } from '../../../src/repl/state/tokenBuffer.js';
import { TOKEN_BUFFER_CAP } from '../../../src/repl/config.js';

beforeEach(() => {
  resetTokenBuffer();
});

describe('TokenBuffer.push', () => {
  it('appends a token to the read view', () => {
    tokenBuffer.push('hello');
    expect(tokenBuffer.read()).toEqual(['hello']);
  });

  it('ignores empty tokens', () => {
    tokenBuffer.push('');
    expect(tokenBuffer.read()).toEqual([]);
  });

  it('drops oldest token on overflow (FIFO)', () => {
    for (let i = 0; i < TOKEN_BUFFER_CAP + 5; i++) {
      tokenBuffer.push(`t${i}`);
    }
    const tokens = tokenBuffer.read();
    expect(tokens).toHaveLength(TOKEN_BUFFER_CAP);
    expect(tokens[0]).toBe(`t5`); // first 5 dropped
    expect(tokens[tokens.length - 1]).toBe(`t${TOKEN_BUFFER_CAP + 4}`);
    expect(tokenBuffer.metrics().droppedFromCap).toBe(5);
  });

  it('readJoined concatenates without separator', () => {
    tokenBuffer.push('a');
    tokenBuffer.push('b');
    tokenBuffer.push('c');
    expect(tokenBuffer.readJoined()).toBe('abc');
  });
});

describe('TokenBuffer.pushBlock', () => {
  it('appends a multi-line block atomically', () => {
    tokenBuffer.pushBlock('line1\nline2\nline3');
    expect(tokenBuffer.read()).toEqual(['line1\nline2\nline3']);
    expect(tokenBuffer.readJoined()).toBe('line1\nline2\nline3');
  });
});

describe('TokenBuffer.reset', () => {
  it('clears tokens and bumps version immediately (no setImmediate wait)', () => {
    tokenBuffer.push('x');
    const v1 = tokenBuffer.getSnapshot();
    tokenBuffer.reset('task-42');
    expect(tokenBuffer.read()).toEqual([]);
    expect(tokenBuffer.streamingTaskId).toBe('task-42');
    expect(tokenBuffer.getSnapshot()).toBeGreaterThan(v1);
  });

  it('resetTokenBuffer test helper clears streamingTaskId', () => {
    tokenBuffer.reset('task-99');
    expect(tokenBuffer.streamingTaskId).toBe('task-99');
    resetTokenBuffer();
    expect(tokenBuffer.streamingTaskId).toBeNull();
  });
});

describe('TokenBuffer.finalize', () => {
  it('clears streamingTaskId but keeps tokens', () => {
    tokenBuffer.reset('t1');
    tokenBuffer.push('hello');
    tokenBuffer.push(' world');
    tokenBuffer.finalize();
    expect(tokenBuffer.streamingTaskId).toBeNull();
    expect(tokenBuffer.readJoined()).toBe('hello world');
  });
});

describe('TokenBuffer.subscribe + getSnapshot', () => {
  it('getSnapshot returns the same primitive when nothing changes', () => {
    const v1 = tokenBuffer.getSnapshot();
    const v2 = tokenBuffer.getSnapshot();
    expect(v1).toBe(v2);
  });

  it('subscribe returns an unsubscribe function', () => {
    let calls = 0;
    const unsub = tokenBuffer.subscribe(() => { calls++; });
    expect(typeof unsub).toBe('function');
    tokenBuffer.reset(); // reset notifies immediately
    expect(calls).toBeGreaterThanOrEqual(1);
    unsub();
    const callsBefore = calls;
    tokenBuffer.reset();
    expect(calls).toBe(callsBefore);
  });

  it('multiple pushes within one tick coalesce into a single notify', async () => {
    let calls = 0;
    tokenBuffer.subscribe(() => { calls++; });
    tokenBuffer.push('a');
    tokenBuffer.push('b');
    tokenBuffer.push('c');
    expect(calls).toBe(0); // setImmediate not yet fired
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1); // 3 pushes → 1 notify
    expect(tokenBuffer.metrics().flushesCoalesced).toBeGreaterThanOrEqual(2);
  });
});

describe('TokenBuffer.metrics', () => {
  it('reports current count, dropped, and version', () => {
    tokenBuffer.push('one');
    tokenBuffer.push('two');
    const m = tokenBuffer.metrics();
    expect(m.count).toBe(2);
    expect(m.droppedFromCap).toBe(0);
    expect(m.version).toBeGreaterThanOrEqual(0);
  });
});
