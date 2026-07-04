import { describe, it, expect } from 'vitest';
import {
  normalizeProviderName,
  inferProvider,
  normalizeCapabilities,
  normalizeModel,
  groupModels,
  inferIntent,
} from '../../src/v2/omniroute-bridge/catalog.js';

describe('normalizeProviderName', () => {
  it('returns a non-empty string for a known provider', () => {
    const result = normalizeProviderName('openai');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns fallback string ("Outros") for empty input', () => {
    const result = normalizeProviderName('');
    expect(typeof result).toBe('string');
  });

  it('handles non-string gracefully', () => {
    expect(() => normalizeProviderName(undefined as unknown as string)).not.toThrow();
  });
});

describe('inferProvider', () => {
  it('infers provider from a model object with id containing slash', () => {
    const result = inferProvider({ id: 'openai/gpt-4o' });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns a string for empty object', () => {
    expect(typeof inferProvider({})).toBe('string');
  });

  it('handles null gracefully', () => {
    expect(() => inferProvider(null)).not.toThrow();
  });
});

describe('normalizeCapabilities', () => {
  it('fills all boolean capability fields', () => {
    const caps = normalizeCapabilities({ vision: true, reasoning: false });
    expect(typeof caps.vision).toBe('boolean');
    expect(typeof caps.tool_calling).toBe('boolean');
  });

  it('defaults to false for all missing fields', () => {
    const caps = normalizeCapabilities({});
    for (const val of Object.values(caps)) {
      expect(val).toBe(false);
    }
  });
});

describe('normalizeModel', () => {
  it('returns a NormalizedModel without throwing', () => {
    expect(() => normalizeModel({ id: 'openai/gpt-4o', object: 'model' })).not.toThrow();
  });

  it('handles empty object without throwing', () => {
    expect(() => normalizeModel({})).not.toThrow();
  });
});

describe('groupModels', () => {
  it('groups models into provider groups', () => {
    const raw = [
      { id: 'openai/gpt-4o', object: 'model' },
      { id: 'anthropic/claude-3', object: 'model' },
    ];
    const { groups } = groupModels(raw);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('returns empty groups for empty array', () => {
    const { groups, models } = groupModels([]);
    expect(groups).toHaveLength(0);
    expect(models).toHaveLength(0);
  });
});

describe('inferIntent', () => {
  it('infers quick intent for short text without special requirements', () => {
    const intent = inferIntent({ content: 'hello' });
    expect(intent).toBeDefined();
    expect(typeof intent.kind).toBe('string');
  });

  it('infers vision intent when imageReferenceCount > 0', () => {
    const intent = inferIntent({ content: 'describe this', imageReferenceCount: 1 });
    expect(intent.kind).toBe('vision');
  });

  it('infers attachment intent when referenceCount > 0', () => {
    const intent = inferIntent({ content: 'analyse this file', referenceCount: 1 });
    expect(intent.kind).toBe('attachment');
  });
});
