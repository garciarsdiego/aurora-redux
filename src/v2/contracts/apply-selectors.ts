import { estimateTokens } from '../context-engine/estimate-tokens.js';

export type SelectorValue = string[] | 'summary_only' | 'raw_full';

export type ApplySelectorResult = {
  sliced: string;
  tokensBefore: number;
  tokensAfter: number;
};

export function applySelector(
  content: string,
  selector: SelectorValue,
): ApplySelectorResult {
  const countTokens = (s: string) => estimateTokens([{ role: 'user', content: s }]);
  const tokensBefore = countTokens(content);

  let sliced: string;
  if (selector === 'raw_full') {
    sliced = content;
  } else if (selector === 'summary_only') {
    const firstPara = content.split(/\n\n/)[0] ?? content;
    sliced = firstPara.length <= 500 ? firstPara : content.slice(0, 500);
  } else {
    // string[] — try JSON field extraction
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const field of selector) {
        if (Object.prototype.hasOwnProperty.call(parsed, field)) {
          picked[field] = parsed[field];
        }
      }
      sliced = JSON.stringify(picked);
    } catch {
      sliced = content;
    }
  }

  return { sliced, tokensBefore, tokensAfter: countTokens(sliced) };
}
