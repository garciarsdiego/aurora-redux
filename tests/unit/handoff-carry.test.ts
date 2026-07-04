import { describe, expect, it } from 'vitest';
import { compactCarrySections, formatCarryBlock, splitCarryBlocks } from '../../src/v2/handoff/carry.js';
import type { ParsedHandoff } from '../../src/v2/handoff/types.js';

function parsed(overrides: Partial<ParsedHandoff> = {}): ParsedHandoff {
  return {
    Summary: '',
    Actions: '',
    Artifacts: '',
    Risks: '',
    Next: '',
    sawHeading: true,
    ...overrides,
  };
}

describe('handoff carry compaction', () => {
  it('keeps sections within caps without truncation', () => {
    const result = compactCarrySections(
      parsed({
        Summary: 'short summary',
        Artifacts: '- src/foo.ts:12',
        Risks: 'low risk',
        Next: 'run tests',
      }),
      5000,
    );

    expect(result.truncatedSections).toEqual([]);
    expect(result.sections).toEqual({
      Summary: 'short summary',
      Artifacts: '- src/foo.ts:12',
      Risks: 'low risk',
      Next: 'run tests',
    });
  });

  it('truncates a single section over its cap with marker suffix', () => {
    const result = compactCarrySections(
      parsed({
        Summary: 'S'.repeat(120),
        Artifacts: 'artifact',
      }),
      1000,
      { Summary: 80, Artifacts: 200, Risks: 200, Next: 200 },
    );

    expect(result.truncatedSections).toEqual(['Summary']);
    expect(result.sections.Summary).toHaveLength(80);
    expect(result.sections.Summary.endsWith('[...truncated]')).toBe(true);
    expect(result.sections.Artifacts).toBe('artifact');
  });

  it('scales all section caps down proportionally when total budget is tight', () => {
    const result = compactCarrySections(
      parsed({
        Summary: 'S'.repeat(300),
        Artifacts: 'A'.repeat(300),
        Risks: 'R'.repeat(300),
        Next: 'N'.repeat(300),
      }),
      500,
      { Summary: 400, Artifacts: 400, Risks: 400, Next: 400 },
    );

    expect(result.truncatedSections).toEqual(['Summary', 'Artifacts', 'Risks', 'Next']);
    expect(result.sections.Summary.length).toBeLessThan(300);
    expect(result.sections.Artifacts.length).toBeLessThan(300);
    expect(result.sections.Risks.length).toBeLessThan(300);
    expect(result.sections.Next.length).toBeLessThan(300);
    for (const value of Object.values(result.sections)) {
      expect(value.endsWith('[...truncated]')).toBe(true);
    }
  });

  it('formats empty input as a carry block with Summary None', () => {
    const result = formatCarryBlock('Step One', parsed(), 1000);

    expect(result.truncated).toBe(false);
    expect(result.truncatedSections).toEqual([]);
    expect(result.text).toContain('### Step One');
    expect(result.text).toContain('#### Summary\nNone');
  });

  it('splits formatted carry blocks by step heading roundtrip', () => {
    const first = formatCarryBlock('Step One', parsed({ Summary: 'one' }), 1000).text;
    const second = formatCarryBlock('Step Two', parsed({ Summary: 'two' }), 1000).text;
    const combined = `${first}\n\n${second}`;

    expect(splitCarryBlocks(combined)).toEqual([first, second]);
  });
});
