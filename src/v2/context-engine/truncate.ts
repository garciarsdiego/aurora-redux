import type { AgentMessage } from './types.js';
import { estimateTokens } from './estimate-tokens.js';

// 70% head + 20% tail, gap filled with marker.
// Operates at message boundary — preserves role/content integrity.
export function truncate7020(
  messages: AgentMessage[],
  tokenBudget: number,
  model?: string,
): AgentMessage[] {
  const current = estimateTokens(messages, model);
  if (current <= tokenBudget) return messages;

  const headBudget = Math.floor(tokenBudget * 0.7);
  const tailBudget = Math.floor(tokenBudget * 0.2);

  const head: AgentMessage[] = [];
  let headTokens = 0;
  for (const msg of messages) {
    const msgTokens = estimateTokens([msg], model);
    if (headTokens + msgTokens > headBudget) break;
    head.push(msg);
    headTokens += msgTokens;
  }

  const tail: AgentMessage[] = [];
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= head.length; i--) {
    const msgTokens = estimateTokens([messages[i]!], model);
    if (tailTokens + msgTokens > tailBudget) break;
    tail.unshift(messages[i]!);
    tailTokens += msgTokens;
  }

  const dropped = messages.length - head.length - tail.length;
  if (dropped === 0) return messages;

  const marker: AgentMessage = {
    id: 'truncate-marker',
    role: 'system',
    content: `[...truncated: ${dropped} messages omitted of ${messages.length} total, kept ${head.length} head + ${tail.length} tail...]`,
  };

  return [...head, marker, ...tail];
}
