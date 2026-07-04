import type { HandoffSection, ParsedHandoff } from './types.js';
import { HANDOFF_SECTIONS } from './types.js';

/**
 * Matches H1–H3 headings (optional #s) for any of the 5 section names,
 * with an optional trailing colon.
 * Examples matched:
 *   ## Summary
 *   ### Actions
 *   Summary:
 *   # Risks :
 */
const HEADING_RE = /^[ \t]*(#{1,3}\s*)?(Summary|Actions|Artifacts|Risks|Next)\s*:?\s*$/im;

/**
 * Build a per-line parser regex anchored at line start.
 */
function buildSectionRE(): RegExp {
  return new RegExp(
    `^[ \\t]*(#{1,3}\\s*)?(${HANDOFF_SECTIONS.join('|')})\\s*:?\\s*$`,
    'im',
  );
}

export function extractHandoffSections(text: string): ParsedHandoff {
  const empty: ParsedHandoff = {
    Summary: '',
    Actions: '',
    Artifacts: '',
    Risks: '',
    Next: '',
    sawHeading: false,
  };

  if (!text || text.trim() === '') return empty;

  // Split into lines and scan for section headings
  const lines = text.split('\n');
  const sectionRE = new RegExp(
    `^[ \\t]*(#{1,3}\\s*)?(${HANDOFF_SECTIONS.join('|')})\\s*:?\\s*$`,
    'i',
  );

  type Segment = { section: HandoffSection; startLine: number };
  const segments: Segment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = sectionRE.exec(lines[i]);
    if (m) {
      segments.push({ section: m[2] as HandoffSection, startLine: i });
    }
  }

  if (segments.length === 0) {
    // No headings found — entire text becomes Summary
    return { ...empty, Summary: text.trim(), sawHeading: false };
  }

  const result: ParsedHandoff = { ...empty, sawHeading: true };

  for (let si = 0; si < segments.length; si++) {
    const { section, startLine } = segments[si];
    const endLine = si + 1 < segments.length ? segments[si + 1].startLine : lines.length;
    // Content is lines after the heading line up to next heading
    const content = lines
      .slice(startLine + 1, endLine)
      .join('\n')
      .trim();
    result[section] = content;
  }

  // If no Summary but Actions populated → promote Actions to Summary
  if (!result.Summary && result.Actions) {
    result.Summary = result.Actions;
  }

  return result;
}
