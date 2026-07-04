// Helpers for stepwise advisor prompts (AETHER γ).

import type { StepHistory } from './conversationMemory.js';

export function formatStepHistoryBlock(history: StepHistory[]): string {
  if (history.length === 0) {
    return '(First step — no prior advisor outputs in this conversation.)';
  }
  return history.map((h) => `### Prior step ${h.step} output\n${h.output}`).join('\n\n');
}

/** Parses the last `[CONTINUE: …]` tag from model output (case-insensitive). */
export function extractContinueFocus(text: string): string | undefined {
  const matches = [...text.matchAll(/\[CONTINUE:\s*([^\]]+?)\]/gi)];
  const last = matches[matches.length - 1];
  const focus = last?.[1]?.trim();
  return focus || undefined;
}
