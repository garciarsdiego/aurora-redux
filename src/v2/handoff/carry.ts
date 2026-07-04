import { CARRY_SECTIONS, DEFAULT_CARRY_CAPS, type CarrySectionCaps, type ParsedHandoff } from './types.js';

type CarrySection = Exclude<(typeof CARRY_SECTIONS)[number], 'Actions'>;

const TRUNCATED_SUFFIX = '[...truncated]';
const SECTION_HEADING_PREFIX = '#### ';
const CARRY_SECTION_NAMES = CARRY_SECTIONS as readonly CarrySection[];

function truncateWithSuffix(content: string, cap: number): string {
  if (content.length <= cap) {
    return content;
  }

  const bodyCap = Math.max(0, cap - TRUNCATED_SUFFIX.length);
  return `${content.slice(0, bodyCap)}${TRUNCATED_SUFFIX}`;
}

function sumCaps(caps: CarrySectionCaps): number {
  return CARRY_SECTION_NAMES.reduce((total, section) => total + caps[section], 0);
}

function compactWithCaps(
  sections: ParsedHandoff,
  maxCarryChars: number,
  baseCaps: CarrySectionCaps,
): { sections: Record<CarrySection, string>; truncatedSections: CarrySection[] } {
  const totalCaps = sumCaps(baseCaps);
  const scale = Math.min(1, maxCarryChars / (totalCaps + 200));
  const compacted = {} as Record<CarrySection, string>;
  const truncatedSections: CarrySection[] = [];

  for (const section of CARRY_SECTION_NAMES) {
    const content = sections[section].trim();
    const cap = Math.max(60, Math.floor(baseCaps[section] * scale));
    compacted[section] = truncateWithSuffix(content, cap);
    if (compacted[section] !== content) {
      truncatedSections.push(section);
    }
  }

  return { sections: compacted, truncatedSections };
}

function mergeTruncatedSections(existing: CarrySection[], next: CarrySection[]): CarrySection[] {
  const merged = new Set<CarrySection>(existing);
  for (const section of next) {
    merged.add(section);
  }
  return CARRY_SECTION_NAMES.filter((section) => merged.has(section));
}

function renderCarryBlock(stepTitle: string, sections: Record<CarrySection, string>): string {
  const hasCarryContent = CARRY_SECTION_NAMES.some((section) => sections[section].trim().length > 0);

  if (!hasCarryContent) {
    return `### ${stepTitle}\n${SECTION_HEADING_PREFIX}Summary\nNone`;
  }

  const chunks = [`### ${stepTitle}`];
  for (const section of CARRY_SECTION_NAMES) {
    const content = sections[section].trim() || 'None';
    chunks.push(`${SECTION_HEADING_PREFIX}${section}\n${content}`);
  }
  return chunks.join('\n\n');
}

function blockOverhead(stepTitle: string, sections: readonly CarrySection[]): number {
  const emptySections = {} as Record<CarrySection, string>;
  for (const section of CARRY_SECTION_NAMES) {
    emptySections[section] = sections.includes(section) ? '' : '';
  }
  return renderCarryBlock(stepTitle, emptySections).length;
}

export function compactCarrySections(
  sections: ParsedHandoff,
  maxCarryChars: number,
  baseCaps: CarrySectionCaps = DEFAULT_CARRY_CAPS,
): { sections: Record<CarrySection, string>; truncatedSections: CarrySection[] } {
  return compactWithCaps(sections, maxCarryChars, baseCaps);
}

export function formatCarryBlock(
  stepTitle: string,
  parsedHandoff: ParsedHandoff,
  maxCarryChars: number,
): { text: string; truncated: boolean; truncatedSections: CarrySection[] } {
  let { sections, truncatedSections } = compactCarrySections(parsedHandoff, maxCarryChars);
  let text = renderCarryBlock(stepTitle, sections);

  if (text.length <= maxCarryChars) {
    return { text, truncated: truncatedSections.length > 0, truncatedSections };
  }

  const nonEmptySections = CARRY_SECTION_NAMES.filter((section) => sections[section].trim().length > 0);
  if (nonEmptySections.length === 0) {
    return { text, truncated: text.length > maxCarryChars, truncatedSections };
  }

  const headingOverhead = Math.max(0, text.length - CARRY_SECTION_NAMES.reduce((total, section) => total + sections[section].length, 0));
  const availableContent = Math.max(nonEmptySections.length * 60, maxCarryChars - headingOverhead);
  const currentContent = nonEmptySections.reduce((total, section) => total + sections[section].length, 0);
  const ratio = Math.min(1, availableContent / Math.max(1, currentContent));
  const secondaryCaps = { ...DEFAULT_CARRY_CAPS };

  for (const section of CARRY_SECTION_NAMES) {
    secondaryCaps[section] = nonEmptySections.includes(section)
      ? Math.max(60, Math.floor(sections[section].length * ratio))
      : 60;
  }

  const secondary = compactWithCaps(parsedHandoff, Math.max(60, maxCarryChars - blockOverhead(stepTitle, nonEmptySections)), secondaryCaps);
  sections = secondary.sections;
  truncatedSections = mergeTruncatedSections(truncatedSections, secondary.truncatedSections);
  text = renderCarryBlock(stepTitle, sections);

  while (text.length > maxCarryChars && nonEmptySections.length > 0) {
    let longest = nonEmptySections[0];
    for (const section of nonEmptySections) {
      if (sections[section].length > sections[longest].length) {
        longest = section;
      }
    }
    const nextCap = Math.max(60, sections[longest].length - Math.max(20, text.length - maxCarryChars));
    sections[longest] = truncateWithSuffix(parsedHandoff[longest].trim(), nextCap);
    truncatedSections = mergeTruncatedSections(truncatedSections, [longest]);
    text = renderCarryBlock(stepTitle, sections);

    if (sections[longest].length <= 60) {
      break;
    }
  }

  return { text, truncated: truncatedSections.length > 0 || text.length > maxCarryChars, truncatedSections };
}

export function splitCarryBlocks(carry: string): string[] {
  const trimmed = carry.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const matches = [...trimmed.matchAll(/^###\s+/gm)];
  if (matches.length === 0) {
    return [trimmed];
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? trimmed.length : trimmed.length;
    return trimmed.slice(start, end).trim();
  });
}
