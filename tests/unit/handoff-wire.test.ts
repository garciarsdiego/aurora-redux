/**
 * Tests for src/v2/handoff/wire.ts — adapter between persona/text outputs and
 * the formatCarryBlock primitive.
 *
 * These tests cover three input shapes (parsed_handoff JSON envelope, naked
 * ParsedHandoff JSON, raw text with headings) and the budget-allocation
 * behaviour of buildCarryFromUpstream when multiple parents share a cap.
 */

import { describe, it, expect } from 'vitest';

import {
  extractHandoffFromOutput,
  buildCarryFromUpstream,
  DEFAULT_MAX_CARRY_CHARS,
  MIN_PER_PARENT_CARRY_CHARS,
} from '../../src/v2/handoff/wire.js';

describe('extractHandoffFromOutput', () => {
  it('returns null on empty / whitespace input', () => {
    expect(extractHandoffFromOutput(null)).toBeNull();
    expect(extractHandoffFromOutput('')).toBeNull();
    expect(extractHandoffFromOutput('   \n  ')).toBeNull();
  });

  it('parses persona-output envelope { parsed_handoff: ... }', () => {
    const envelope = JSON.stringify({
      result_text: 'irrelevant',
      parsed_handoff: {
        Summary: 'created auth scaffold',
        Actions: 'wrote src/auth.ts',
        Artifacts: 'src/auth.ts:1-42',
        Risks: 'no rate-limit yet',
        Next: 'add tests',
        sawHeading: true,
      },
    });
    const out = extractHandoffFromOutput(envelope);
    expect(out).not.toBeNull();
    expect(out!.Summary).toBe('created auth scaffold');
    expect(out!.Artifacts).toBe('src/auth.ts:1-42');
    expect(out!.Next).toBe('add tests');
  });

  it('parses naked ParsedHandoff JSON', () => {
    const raw = JSON.stringify({
      Summary: 'did stuff',
      Actions: 'ran some commands',
      Artifacts: '',
      Risks: '',
      Next: 'continue',
      sawHeading: true,
    });
    const out = extractHandoffFromOutput(raw);
    expect(out).not.toBeNull();
    expect(out!.Summary).toBe('did stuff');
    expect(out!.Next).toBe('continue');
  });

  it('falls back to extractHandoffSections for raw text with markdown headings', () => {
    const text = `Some preamble that does not matter.

## Summary
Worker finished writing the dashboard component.

## Actions
1. Created Dashboard.tsx
2. Wired routes

## Artifacts
- apps/dashboard-v2/src/Dashboard.tsx:1-120

## Risks
None.

## Next
Add unit tests.`;
    const out = extractHandoffFromOutput(text);
    expect(out).not.toBeNull();
    expect(out!.Summary).toContain('Worker finished');
    expect(out!.Actions).toContain('Created Dashboard.tsx');
    expect(out!.Artifacts).toContain('Dashboard.tsx:1-120');
    expect(out!.Next).toContain('unit tests');
    expect(out!.sawHeading).toBe(true);
  });

  it('returns Summary-only fallback when text has no headings', () => {
    const out = extractHandoffFromOutput('Just a plain string with no structure.');
    expect(out).not.toBeNull();
    expect(out!.Summary).toBe('Just a plain string with no structure.');
    expect(out!.sawHeading).toBe(false);
  });

  it('treats invalid JSON-looking strings as text and parses headings', () => {
    const text = `{not valid json
## Summary
fallback worked`;
    const out = extractHandoffFromOutput(text);
    expect(out).not.toBeNull();
    expect(out!.Summary).toContain('fallback worked');
  });

  it('rejects JSON object with unrelated keys (no handoff signals)', () => {
    const obj = JSON.stringify({ foo: 'bar', baz: 42 });
    const out = extractHandoffFromOutput(obj);
    // Falls through to text extraction; no headings → Summary becomes raw text
    expect(out).not.toBeNull();
    expect(out!.Summary).toContain('foo');
    expect(out!.sawHeading).toBe(false);
  });
});

describe('buildCarryFromUpstream', () => {
  const parentWithSections = (id: string, name: string, summary: string) => ({
    id,
    name,
    output_json: JSON.stringify({
      parsed_handoff: {
        Summary: summary,
        Actions: 'did things',
        Artifacts: 'file.ts',
        Risks: 'none',
        Next: 'next step',
        sawHeading: true,
      },
    }),
  });

  it('returns empty result for zero parents', () => {
    const out = buildCarryFromUpstream([]);
    expect(out.text).toBe('');
    expect(out.sources).toHaveLength(0);
    expect(out.totalChars).toBe(0);
  });

  it('returns empty result when no parent has parseable handoff', () => {
    const out = buildCarryFromUpstream([
      { id: 't1', name: 'task1', output_json: null },
      { id: 't2', name: 'task2', output_json: '   ' },
    ]);
    expect(out.text).toBe('');
    expect(out.sources).toHaveLength(0);
  });

  it('produces a single carry block from one parent', () => {
    const out = buildCarryFromUpstream([parentWithSections('t1', 'parent_one', 'first task')]);
    expect(out.text).toContain('### parent_one');
    expect(out.text).toContain('Summary');
    expect(out.text).toContain('first task');
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].parentTaskId).toBe('t1');
  });

  it('joins multiple parents with section separators', () => {
    const out = buildCarryFromUpstream([
      parentWithSections('t1', 'parent_one', 'alpha'),
      parentWithSections('t2', 'parent_two', 'beta'),
    ]);
    expect(out.text).toContain('### parent_one');
    expect(out.text).toContain('### parent_two');
    expect(out.text).toContain('alpha');
    expect(out.text).toContain('beta');
    expect(out.sources).toHaveLength(2);
  });

  it('drops parents without handoffs but keeps those that have them', () => {
    const out = buildCarryFromUpstream([
      parentWithSections('t1', 'good', 'has handoff'),
      { id: 't2', name: 'silent', output_json: '' },
      parentWithSections('t3', 'also_good', 'also has handoff'),
    ]);
    expect(out.sources).toHaveLength(2);
    expect(out.sources.map((s) => s.parentTaskId)).toEqual(['t1', 't3']);
    expect(out.text).toContain('### good');
    expect(out.text).toContain('### also_good');
    expect(out.text).not.toContain('### silent');
  });

  it('respects maxChars budget across multiple parents', () => {
    const longSummary = 'X'.repeat(5000);
    const parents = [
      parentWithSections('t1', 'p1', longSummary),
      parentWithSections('t2', 'p2', longSummary),
      parentWithSections('t3', 'p3', longSummary),
    ];
    const out = buildCarryFromUpstream(parents, 3000);
    // Allow some overhead for headings; total should be in the same ballpark as the cap
    expect(out.totalChars).toBeLessThan(3000 + 500);
    expect(out.sources.every((s) => s.truncated)).toBe(true);
  });

  it('honours MIN_PER_PARENT_CARRY_CHARS floor — drops late parents on tiny budgets', () => {
    const parents = [
      parentWithSections('t1', 'p1', 'Alpha summary content'),
      parentWithSections('t2', 'p2', 'Beta summary content'),
      parentWithSections('t3', 'p3', 'Gamma summary content'),
      parentWithSections('t4', 'p4', 'Delta summary content'),
    ];
    // Budget below 4 * MIN_PER_PARENT — should drop later parents
    const out = buildCarryFromUpstream(parents, MIN_PER_PARENT_CARRY_CHARS * 2);
    expect(out.sources.length).toBeLessThan(parents.length);
    expect(out.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('default cap matches DEFAULT_MAX_CARRY_CHARS when not provided', () => {
    expect(DEFAULT_MAX_CARRY_CHARS).toBe(4000);
    const out = buildCarryFromUpstream([parentWithSections('t1', 'only', 'tiny')]);
    expect(out.totalChars).toBeLessThanOrEqual(DEFAULT_MAX_CARRY_CHARS);
  });

  it('records truncation metadata per source', () => {
    const big = 'Y'.repeat(8000);
    const out = buildCarryFromUpstream([parentWithSections('t1', 'big', big)], 1000);
    expect(out.sources[0].truncated).toBe(true);
    expect(out.sources[0].truncatedSections.length).toBeGreaterThan(0);
  });
});
