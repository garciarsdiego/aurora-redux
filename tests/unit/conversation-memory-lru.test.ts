import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _getStoreSize,
  _resetStore,
  appendStep,
  completeConversation,
  ensureConversation,
  getActiveConversations,
  getHistory,
} from '../../src/v2/advisors/shared/conversationMemory.js';

const ENV_KEY = 'ADVISOR_CONVERSATION_CACHE_SIZE';

describe('conversationMemory LRU cap', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    _resetStore();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    _resetStore();
  });

  it('honors a small custom cap via env var and FIFO-evicts the oldest entry', () => {
    process.env[ENV_KEY] = '3';

    ensureConversation('c1', 'consensus', 'ws1');
    ensureConversation('c2', 'consensus', 'ws1');
    ensureConversation('c3', 'consensus', 'ws1');
    expect(_getStoreSize()).toBe(3);

    // Inserting a 4th must evict c1 (oldest insertion order)
    ensureConversation('c4', 'consensus', 'ws1');
    expect(_getStoreSize()).toBe(3);
    expect(getHistory('c1')).toEqual([]); // unknown id → empty history
    expect(getHistory('c4')).toEqual([]); // exists but empty
    // c2/c3/c4 should remain
    appendStep('c2', 1, 'still alive');
    appendStep('c3', 1, 'still alive');
    appendStep('c4', 1, 'still alive');
    expect(getHistory('c2')).toHaveLength(1);
    expect(getHistory('c3')).toHaveLength(1);
    expect(getHistory('c4')).toHaveLength(1);
  });

  it('drops conversations explicitly via completeConversation()', () => {
    ensureConversation('done-id', 'planner', 'ws1');
    appendStep('done-id', 1, 'step content');
    expect(_getStoreSize()).toBe(1);

    completeConversation('done-id');
    expect(_getStoreSize()).toBe(0);
    expect(getHistory('done-id')).toEqual([]);
  });

  it('completeConversation is idempotent for unknown ids', () => {
    expect(() => completeConversation('never-existed')).not.toThrow();
    expect(_getStoreSize()).toBe(0);
  });

  it('falls back to default cap (200) when env is unset', () => {
    delete process.env[ENV_KEY];

    for (let i = 0; i < 201; i += 1) {
      ensureConversation(`conv-${i}`, 'consensus', 'ws1');
    }
    // After 201 inserts the cap (200) clips to 200 with the oldest evicted.
    expect(_getStoreSize()).toBe(200);
    expect(getHistory('conv-0')).toEqual([]); // evicted
    appendStep('conv-200', 1, 'youngest survives');
    expect(getHistory('conv-200')).toHaveLength(1);
  });

  it('rejects non-numeric / non-positive env overrides and uses default', () => {
    process.env[ENV_KEY] = 'not-a-number';
    for (let i = 0; i < 201; i += 1) {
      ensureConversation(`conv-${i}`, 'consensus', 'ws1');
    }
    expect(_getStoreSize()).toBe(200);

    _resetStore();
    process.env[ENV_KEY] = '0';
    for (let i = 0; i < 201; i += 1) {
      ensureConversation(`conv-${i}`, 'consensus', 'ws1');
    }
    expect(_getStoreSize()).toBe(200);
  });

  it('preserves taskId lookups through eviction', () => {
    process.env[ENV_KEY] = '2';
    ensureConversation('c1', 'consensus', 'ws1', 'task-A');
    ensureConversation('c2', 'consensus', 'ws1', 'task-A');
    expect(getActiveConversations('task-A')).toHaveLength(2);

    ensureConversation('c3', 'consensus', 'ws1', 'task-A'); // evicts c1
    expect(getActiveConversations('task-A')).toEqual(expect.arrayContaining(['c2', 'c3']));
    expect(getActiveConversations('task-A')).not.toContain('c1');
  });
});
