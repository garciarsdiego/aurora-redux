import { describe, expect, it } from 'vitest';
import {
  routeImageTask,
  type ImageRoutingInput,
  type ModelCandidate,
} from '../../src/v2/model-guidance/image-router.js';

const catalog: ModelCandidate[] = [
  {
    model_id: 'cc/claude-sonnet-4-6',
    provider: 'anthropic',
    has_vision: true,
    cost_tier: 'balanced',
    context_window: 200000,
  },
  {
    model_id: 'cc/claude-haiku-4-5',
    provider: 'anthropic',
    has_vision: true,
    cost_tier: 'cheap',
    context_window: 200000,
  },
  {
    model_id: 'cx/gpt-5.5',
    provider: 'openai',
    has_vision: true,
    cost_tier: 'quality',
    context_window: 128000,
  },
  {
    model_id: 'gemini/gemini-2.5-pro',
    provider: 'google',
    has_vision: true,
    cost_tier: 'balanced',
    context_window: 1000000,
  },
  {
    model_id: 'cc/claude-opus-4-7',
    provider: 'anthropic',
    has_vision: false,
    cost_tier: 'quality',
    context_window: 200000,
  },
];

describe('routeImageTask', () => {
  it('does not filter by vision when hasImages=false', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Summarize a text-only task',
        hasImages: false,
        preferredProvider: 'anthropic',
        costTier: 'quality',
      },
      catalog,
    );

    expect(result.selected.model_id).toBe('cc/claude-opus-4-7');
    expect(result.selected.has_vision).toBe(false);
  });

  it('throws when hasImages=true and no vision models exist', () => {
    expect(() =>
      routeImageTask(
        {
          taskDescription: 'Inspect screenshots',
          hasImages: true,
          preferredProvider: 'any',
          costTier: 'balanced',
        },
        catalog.map((candidate) => ({ ...candidate, has_vision: false })),
      ),
    ).toThrow('hasImages=true but zero vision-capable models exist');
  });

  it('selects an anthropic vision model when preferredProvider=anthropic', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Review annotated image',
        hasImages: true,
        preferredProvider: 'anthropic',
        costTier: 'balanced',
      },
      catalog,
    );

    expect(result.selected.model_id).toBe('cc/claude-sonnet-4-6');
    expect(result.selected.provider).toBe('anthropic');
    expect(result.selected.has_vision).toBe(true);
  });

  it('selects Haiku for cheap anthropic image tasks', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Classify a low-priority image batch',
        hasImages: true,
        preferredProvider: 'anthropic',
        costTier: 'cheap',
      },
      catalog,
    );

    expect(result.selected.model_id).toBe('cc/claude-haiku-4-5');
  });

  it('returns more alternatives when preferredProvider=any', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Pick a balanced multimodal model',
        hasImages: true,
        preferredProvider: 'any',
        costTier: 'balanced',
      },
      catalog,
    );

    expect(result.selected.model_id).toBe('cc/claude-sonnet-4-6');
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].model_id).toBe('gemini/gemini-2.5-pro');
  });

  it('falls back gracefully by relaxing costTier before provider', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Find a cheap google vision model',
        hasImages: true,
        preferredProvider: 'google',
        costTier: 'cheap',
      },
      catalog,
    );

    expect(result.selected.model_id).toBe('gemini/gemini-2.5-pro');
    expect(result.selected.provider).toBe('google');
  });

  it('falls back to any provider when preferred provider has no vision candidates', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Find an openai cheap image model',
        hasImages: true,
        preferredProvider: 'openai',
        costTier: 'cheap',
      },
      catalog.map((candidate) =>
        candidate.provider === 'openai'
          ? { ...candidate, has_vision: false }
          : candidate,
      ),
    );

    expect(result.selected.model_id).toBe('cc/claude-haiku-4-5');
    expect(result.selected.provider).toBe('anthropic');
  });

  it('includes the selected model and routing fields in the rationale', () => {
    const result = routeImageTask(
      {
        taskDescription: 'Explain a chart',
        hasImages: true,
        preferredProvider: 'anthropic',
        costTier: 'cheap',
      },
      catalog,
    );

    expect(result.rationale).toContain('cc/claude-haiku-4-5');
    expect(result.rationale).toContain('hasImages=true');
    expect(result.rationale).toContain('vision=true');
    expect(result.rationale).toContain('costTier=cheap');
    expect(result.rationale).toContain('provider=anthropic');
  });

  it('throws ZodError on invalid input', () => {
    const invalidInput = {
      taskDescription: '',
      hasImages: true,
      preferredProvider: 'anthropic',
      costTier: 'cheap',
    } satisfies ImageRoutingInput;

    expect(() =>
      routeImageTask(invalidInput, catalog),
    ).toThrow(/Too small: expected string to have >=1 characters/);
  });
});
