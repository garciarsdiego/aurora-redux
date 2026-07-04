// ── LLM pricing table (USD per million tokens) ───────────────────────────
//
// Keyed by provider prefix. The first matching entry wins; if no prefix
// matches, the DEFAULT entry is used. Per-Mtoken values let callers
// estimate cost from prompt token counts (heuristic: 4 chars/token).
//
// Sources (2026-04):
//   cc/*   → Codex  (Claude family): $3/$15 per Mtok
//   cx/*   → Codex  (GPT family):   $1.25/$10 per Mtok
//   gemini-cli/* → Gemini CLI:      $1.25/$10 per Mtok
//   default → conservative fallback: $1/$3

export interface PricingEntry {
  /** USD per million input tokens */
  inputPerMtok: number;
  /** USD per million output tokens */
  outputPerMtok: number;
}

const PRICING_TABLE: ReadonlyArray<{ prefix: string; entry: PricingEntry }> = [
  { prefix: 'cc/',   entry: { inputPerMtok: 3.0,  outputPerMtok: 15.0 } },
  { prefix: 'cx/',   entry: { inputPerMtok: 1.25, outputPerMtok: 10.0 } },
  { prefix: 'gemini-cli/', entry: { inputPerMtok: 1.25, outputPerMtok: 10.0 } },
];

const DEFAULT_PRICING: PricingEntry = { inputPerMtok: 1.0, outputPerMtok: 3.0 };

export function getPricingForModel(modelId: string): PricingEntry {
  for (const row of PRICING_TABLE) {
    if (modelId.startsWith(row.prefix)) return row.entry;
  }
  return DEFAULT_PRICING;
}

/**
 * Estimate USD cost for a model call from input & output token counts.
 *
 * When real token counts are not yet known (pre-call estimation), the
 * caller typically estimates `inputTokens` via a heuristic like
 * `(systemPrompt.length + userPrompt.length) / 4` and uses 0 for `outputTokens`
 * to get a lower bound.
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getPricingForModel(modelId);
  return (inputTokens / 1_000_000) * pricing.inputPerMtok +
         (outputTokens / 1_000_000) * pricing.outputPerMtok;
}

/**
 * All known pricing entries as a flat record, useful for dashboard
 * cost panels that want to show per-model rates in a table.
 */
export function listPricingEntries(): Array<{ prefix: string } & PricingEntry> {
  return [
    ...PRICING_TABLE.map((r) => ({ prefix: r.prefix, ...r.entry })),
    { prefix: '* (default)', ...DEFAULT_PRICING },
  ];
}
