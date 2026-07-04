import { describe, it, expect } from 'vitest';
import {
  getPricingForModel,
  estimateCost,
  listPricingEntries,
} from '../../src/v2/llm-ledger/pricing.js';

describe('listPricingEntries', () => {
  it('returns a non-empty array of entries', () => {
    const entries = listPricingEntries();
    expect(entries.length).toBeGreaterThan(0);
  });

  it('each entry has prefix, inputPerMtok, outputPerMtok', () => {
    for (const entry of listPricingEntries()) {
      expect(typeof entry.prefix).toBe('string');
      expect(typeof entry.inputPerMtok).toBe('number');
      expect(typeof entry.outputPerMtok).toBe('number');
    }
  });
});

describe('getPricingForModel', () => {
  it('returns pricing for a known cc/ prefix model', () => {
    const pricing = getPricingForModel('cc/claude-sonnet-4-6');
    expect(pricing).not.toBeNull();
    expect(pricing.inputPerMtok).toBeGreaterThan(0);
    expect(pricing.outputPerMtok).toBeGreaterThan(0);
  });

  it('returns fallback pricing for unknown model (not null)', () => {
    const pricing = getPricingForModel('unknown-provider/unknown-model');
    expect(pricing).not.toBeNull();
    expect(typeof pricing.inputPerMtok).toBe('number');
  });

  it('returns pricing for cx/ prefix model', () => {
    const pricing = getPricingForModel('cx/gpt-5.5');
    expect(pricing).not.toBeNull();
    expect(pricing.inputPerMtok).toBeGreaterThan(0);
  });
});

describe('estimateCost', () => {
  it('computes cost from token counts and pricing', () => {
    const cost = estimateCost('cc/claude-sonnet-4-6', 1_000_000, 200_000);
    expect(cost).toBeGreaterThan(0);
  });

  it('returns 0 for 0 tokens', () => {
    const cost = estimateCost('cc/claude-sonnet-4-6', 0, 0);
    expect(cost).toBe(0);
  });

  it('returns a finite number for any known prefix', () => {
    const cost = estimateCost('cx/gpt-5.5', 500, 100);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});
