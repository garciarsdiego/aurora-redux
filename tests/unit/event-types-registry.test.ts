import { describe, it, expect } from 'vitest';
import { EVENT_TYPES, isKnownEventType } from '../../src/runtime/event-types.js';

describe('event-types registry (F7-1)', () => {
  it('EVENT_TYPES is non-empty and has no duplicates', () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
    const set = new Set<string>(EVENT_TYPES);
    expect(set.size).toBe(EVENT_TYPES.length);
  });

  it('isKnownEventType accepts a registered type and rejects unknown strings', () => {
    expect(isKnownEventType('task_started')).toBe(true);
    expect(isKnownEventType('definitely_not_an_event')).toBe(false);
  });
});
