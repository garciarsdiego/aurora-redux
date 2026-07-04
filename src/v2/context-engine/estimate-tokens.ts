import type { AgentMessage } from './types.js';

function ratioFor(model?: string): number {
  if (!model) return 3.8;
  if (model.includes('claude') || model.startsWith('cc/')) return 3.5;
  if (model.includes('gpt') || model.startsWith('cx/') || model.startsWith('gh/')) return 4.0;
  if (model.includes('gemini')) return 3.7;
  return 3.8;
}

export function estimateTokens(messages: AgentMessage[], model?: string): number {
  const ratio = ratioFor(model);
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil(totalChars / ratio) + messages.length * 4;
}
