import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _parseDecision, matchPattern } from '../../src/brain/patternMatcher.js';
import type { Pattern } from '../../src/types/index.js';

function makePattern(name: string, objectiveSample: string): Pattern {
  return {
    id: `pt_${name}`,
    workspace: 'internal',
    name,
    source: 'generated',
    objective_sample: objectiveSample,
    dag_json: JSON.stringify({ tasks: [] }),
    usage_count: 0,
    success_count: 0,
    avg_duration_ms: null,
    last_used_at: null,
    created_at: Date.now(),
  };
}

const PATTERNS = [
  makePattern('landing-page', 'Build landing page for product X'),
  makePattern('blog-post', 'Write blog post about TypeScript generics'),
];

// --- _parseDecision (pure, no network) ---

describe('_parseDecision', () => {
  it('returns { action: "new" } for decision "new"', () => {
    const result = _parseDecision('{"decision":"new"}', PATTERNS);
    expect(result.action).toBe('new');
  });

  it('returns { action: "use", pattern } for valid use:<name>', () => {
    const result = _parseDecision('{"decision":"use:landing-page"}', PATTERNS);
    expect(result.action).toBe('use');
    if (result.action === 'use') {
      expect(result.pattern.name).toBe('landing-page');
    }
  });

  it('falls back to "new" on malformed JSON', () => {
    const result = _parseDecision('not json at all', PATTERNS);
    expect(result.action).toBe('new');
  });

  it('falls back to "new" when decision field is missing', () => {
    const result = _parseDecision('{"foo":"bar"}', PATTERNS);
    expect(result.action).toBe('new');
  });

  it('falls back to "new" when pattern name is unknown', () => {
    const result = _parseDecision('{"decision":"use:nonexistent"}', PATTERNS);
    expect(result.action).toBe('new');
  });

  it('falls back to "new" for unexpected decision value', () => {
    const result = _parseDecision('{"decision":"modify:landing-page"}', PATTERNS);
    expect(result.action).toBe('new');
  });

  it('strips markdown fences before parsing', () => {
    const raw = '```json\n{"decision":"use:blog-post"}\n```';
    const result = _parseDecision(raw, PATTERNS);
    expect(result.action).toBe('use');
    if (result.action === 'use') {
      expect(result.pattern.name).toBe('blog-post');
    }
  });
});

// --- matchPattern (mocks callOmniroute) ---

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn(),
}));

import { callOmniroute } from '../../src/utils/omniroute-call.js';

const mockCallOmniroute = vi.mocked(callOmniroute);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('matchPattern', () => {
  it('returns "new" immediately when patterns list is empty — no LLM call', async () => {
    const result = await matchPattern('Build a landing page', []);
    expect(result.action).toBe('new');
    expect(mockCallOmniroute).not.toHaveBeenCalled();
  });

  it('calls LLM and returns "use" when LLM says use:<name>', async () => {
    mockCallOmniroute.mockResolvedValueOnce('{"decision":"use:landing-page"}');
    const result = await matchPattern('Create a landing page', PATTERNS);
    expect(mockCallOmniroute).toHaveBeenCalledOnce();
    expect(result.action).toBe('use');
    if (result.action === 'use') {
      expect(result.pattern.name).toBe('landing-page');
    }
  });

  it('calls LLM and returns "new" when LLM says new', async () => {
    mockCallOmniroute.mockResolvedValueOnce('{"decision":"new"}');
    const result = await matchPattern('Completely different task', PATTERNS);
    expect(mockCallOmniroute).toHaveBeenCalledOnce();
    expect(result.action).toBe('new');
  });

  it('returns "new" (fallback) when LLM returns malformed JSON', async () => {
    mockCallOmniroute.mockResolvedValueOnce('INVALID JSON {{');
    const result = await matchPattern('Some objective', PATTERNS);
    expect(result.action).toBe('new');
  });

  it('bumpPatternUsage is called after use — verified via run.ts integration (smoke)', async () => {
    // This test just verifies the match returns the full Pattern object needed for bumping
    mockCallOmniroute.mockResolvedValueOnce('{"decision":"use:blog-post"}');
    const result = await matchPattern('Write a blog post about React', PATTERNS);
    expect(result.action).toBe('use');
    if (result.action === 'use') {
      expect(result.pattern.id).toBe('pt_blog-post');
    }
  });
});
