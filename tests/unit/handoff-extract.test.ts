import { describe, it, expect } from 'vitest';
import { extractHandoffSections } from '../../src/v2/handoff/extract.js';

describe('extractHandoffSections', () => {
  it('full sections present → all 5 populated', () => {
    const text = `
## Summary
Did the thing.

## Actions
1. Step one
2. Step two

## Artifacts
- src/foo.ts:10-20

## Risks
May break on Windows.

## Next
Run the tests.
`.trim();

    const result = extractHandoffSections(text);
    expect(result.sawHeading).toBe(true);
    expect(result.Summary).toBe('Did the thing.');
    expect(result.Actions).toContain('Step one');
    expect(result.Artifacts).toBe('- src/foo.ts:10-20');
    expect(result.Risks).toBe('May break on Windows.');
    expect(result.Next).toBe('Run the tests.');
  });

  it('only Summary heading → Actions/Artifacts/Risks/Next empty', () => {
    const text = `## Summary\nOnly a summary here.`;
    const result = extractHandoffSections(text);
    expect(result.sawHeading).toBe(true);
    expect(result.Summary).toBe('Only a summary here.');
    expect(result.Actions).toBe('');
    expect(result.Artifacts).toBe('');
    expect(result.Risks).toBe('');
    expect(result.Next).toBe('');
  });

  it('no headings → fallback Summary = entire text, sawHeading=false', () => {
    const text = 'Just some prose without any headings.';
    const result = extractHandoffSections(text);
    expect(result.sawHeading).toBe(false);
    expect(result.Summary).toBe(text);
    expect(result.Actions).toBe('');
  });

  it('inline colon after heading captured (e.g. "Summary: foo bar")', () => {
    const text = `Summary:\nThis was done inline.\n\nActions:\n1. First`;
    const result = extractHandoffSections(text);
    expect(result.sawHeading).toBe(true);
    expect(result.Summary).toBe('This was done inline.');
    expect(result.Actions).toBe('1. First');
  });

  it('heading variations: ## Summary, ### Summary, Summary:', () => {
    const variants = [
      '## Summary\nH2 style',
      '### Summary\nH3 style',
      'Summary:\nColon style',
    ];
    for (const text of variants) {
      const result = extractHandoffSections(text);
      expect(result.sawHeading).toBe(true);
      expect(result.Summary).not.toBe('');
    }
  });

  it('empty input → all empty + sawHeading=false', () => {
    const result = extractHandoffSections('');
    expect(result.sawHeading).toBe(false);
    expect(result.Summary).toBe('');
    expect(result.Actions).toBe('');
    expect(result.Artifacts).toBe('');
    expect(result.Risks).toBe('');
    expect(result.Next).toBe('');
  });

  it('no Summary but Actions populated → Summary promoted from Actions', () => {
    const text = `## Actions\n1. Only actions here.\n\n## Risks\nSome risk.`;
    const result = extractHandoffSections(text);
    expect(result.sawHeading).toBe(true);
    expect(result.Summary).toBe('1. Only actions here.');
    expect(result.Actions).toBe('1. Only actions here.');
  });
});
