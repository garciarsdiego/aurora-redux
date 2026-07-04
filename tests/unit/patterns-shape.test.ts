// Week 3 / Task 2.3 — objectiveShape() unit tests.
//
// Pins the parameter-stripping behavior that drives pattern auto-capture
// matching across client names, dates, numbers, and URLs.

import { describe, it, expect } from 'vitest';
import { objectiveShape } from '../../src/patterns/shape.js';

describe('objectiveShape', () => {
  it('returns identical shape across different client names', () => {
    const a = objectiveShape('Audit Google Ads account for Acme, 30-day window');
    const b = objectiveShape('Audit Google Ads account for Initech, 7-day window');
    expect(a).toBe(b);
    expect(a).toContain('audit');
    expect(a).toContain('google');
    expect(a).toContain('window');
    expect(a).not.toContain('acme');
    expect(a).not.toContain('initech');
  });

  it('strips numbers, dates, and URLs', () => {
    const shape = objectiveShape('Fetch 5 reports from https://example.com on 2026-05-22');
    expect(shape).not.toMatch(/\d/);
    expect(shape).not.toContain('https');
    expect(shape).not.toContain('example');
    expect(shape).toContain('fetch');
    expect(shape).toContain('reports');
  });

  it('drops stopwords and dedupes tokens', () => {
    const shape = objectiveShape('Summarize the report and the report for the team');
    expect(shape).toContain('summarize');
    expect(shape).toContain('report');
    // 'the', 'and', 'for' are stopwords.
    expect(shape.split(' ')).not.toContain('the');
    expect(shape.split(' ')).not.toContain('and');
    // 'report' appears twice in the input — dedup keeps a single token.
    const reportCount = shape.split(' ').filter((t) => t === 'report').length;
    expect(reportCount).toBe(1);
  });

  it('returns an empty string when normalization wipes everything', () => {
    expect(objectiveShape('')).toBe('');
    expect(objectiveShape('   ')).toBe('');
    expect(objectiveShape('"Acme" 2026-05-22 https://x')).toBe('');
  });

  it('keeps the leading verb of the sentence even when capitalized', () => {
    // First-token capitalization is sentence-start, not a proper noun.
    const shape = objectiveShape('Refactor src/audio for low latency');
    expect(shape).toContain('refactor');
  });
});
