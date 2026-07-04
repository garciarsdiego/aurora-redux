// Week 3 / Task 2.4 — parametric slot detection unit tests.

import { describe, it, expect } from 'vitest';
import { detectSlots, bindSlots } from '../../src/patterns/parametric.js';

describe('detectSlots', () => {
  it('returns null when fewer than 2 inputs are provided', () => {
    expect(detectSlots(['only one'])).toBeNull();
    expect(detectSlots([])).toBeNull();
  });

  it('returns null when inputs have different token counts', () => {
    expect(detectSlots(['short', 'a longer string'])).toBeNull();
  });

  it('emits a single {client} slot for "for <name>" variations', () => {
    const result = detectSlots([
      'Audit Google Ads account for Acme, 30-day window',
      'Audit Google Ads account for Initech, 30-day window',
      'Audit Google Ads account for Globex, 30-day window',
    ]);
    expect(result).not.toBeNull();
    expect(result!.slots).toEqual(['client']);
    expect(result!.template).toContain('{client}');
    expect(result!.template).toContain('Audit Google Ads account for');
    expect(result!.samples.client).toEqual(['Acme', 'Initech', 'Globex']);
  });

  it('detects multiple slots in one objective', () => {
    const result = detectSlots([
      'Summarize last 7 days for Acme',
      'Summarize last 14 days for Initech',
      'Summarize last 30 days for Globex',
    ]);
    expect(result).not.toBeNull();
    // Two differing positions: "7"/"14"/"30" and "Acme"/"Initech"/"Globex".
    expect(result!.slots.length).toBe(2);
    expect(result!.slots).toContain('client');
    expect(result!.slots).toContain('count');
    expect(result!.samples.client).toEqual(['Acme', 'Initech', 'Globex']);
    expect(result!.samples.count).toEqual(['7', '14', '30']);
  });

  it('falls back to {param1} when no semantic name fits', () => {
    const result = detectSlots(['Foo bar baz Apple', 'Foo bar baz Orange']);
    expect(result).not.toBeNull();
    expect(result!.slots).toEqual(['param1']);
    expect(result!.samples.param1).toEqual(['Apple', 'Orange']);
  });
});

describe('bindSlots', () => {
  it('substitutes known slots and leaves unknowns intact', () => {
    const out = bindSlots('Hello {client} on {date}', { client: 'Acme', date: '2026-05-22' });
    expect(out).toBe('Hello Acme on 2026-05-22');
  });

  it('leaves unknown slots as literal placeholders', () => {
    const out = bindSlots('Hello {client} on {missing}', { client: 'Acme' });
    expect(out).toBe('Hello Acme on {missing}');
  });
});
